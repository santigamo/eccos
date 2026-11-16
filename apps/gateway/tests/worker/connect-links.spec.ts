import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { CONNECT_LINK_TTL_MS } from "../../src/connect-links";
import { GatewayRPC } from "../../src/rpc";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function rpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

async function workspace(organizationId = "org_agency") {
  const { accountId } = await rpc().ensureOrganizationAccount(organizationId, "Agency");
  return accountId;
}

/** Meta answering an Embedded Signup code with one WABA and one number. */
function mockGraph(wabaId = "WABA_LINK") {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "biz-token" }), { status: 200 });
    }
    if (url.includes("/debug_token")) {
      return new Response(
        JSON.stringify({ data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [wabaId] }] } }),
        { status: 200 },
      );
    }
    if (url.includes("/phone_numbers")) {
      return new Response(JSON.stringify({ data: [{ id: "PN_LINK", display_phone_number: "+34 600 000 222" }] }), {
        status: 200,
      });
    }
    if (url.includes("is_on_biz_app")) {
      return new Response(JSON.stringify({ id: "PN_LINK", is_on_biz_app: true, platform_type: "CLOUD_API" }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
}

async function mintState(accountId: string, state: string) {
  await cp((instance) => instance.startConnectState(state, accountId, Date.now() + 60_000));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("connection links", () => {
  it("stores the selector and a hash, never the token", async () => {
    const accountId = await workspace();
    const { token, expiresAt } = await rpc().issueConnectLink(accountId, "user_ruben");
    expect(token).toMatch(/^[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(expiresAt - Date.now()).toBeGreaterThan(CONNECT_LINK_TTL_MS - 5_000);

    const stored = JSON.stringify(await cp((instance) => instance.sql.exec("SELECT * FROM connect_links").toArray()));
    expect(stored).not.toContain(token.split(".")[1]);
  });

  it("resolves to the account it was made for, and only with the whole secret", async () => {
    const accountId = await workspace();
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");

    expect(await rpc().resolveConnectLink(token)).toEqual({
      accountId,
      organizationId: "org_agency",
      creatorUserId: "user_ruben",
      state: "active",
      connectPolicy: "open",
    });
    const [selector, secret] = token.split(".") as [string, string];
    const flipped = `${selector}.${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    expect(await rpc().resolveConnectLink(flipped)).toBeNull();
    expect(await rpc().resolveConnectLink(selector)).toBeNull();
    expect(await rpc().resolveConnectLink("")).toBeNull();
  });

  it("reads as opened only once the page says so", async () => {
    const accountId = await workspace();
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");

    await rpc().resolveConnectLink(token);
    expect((await rpc().getConnectLink(accountId))?.state).toBe("pending");
    await rpc().resolveConnectLink(token, true);
    expect((await rpc().getConnectLink(accountId))?.state).toBe("opened");
  });

  it("keeps one link per workspace: a new one revokes the previous", async () => {
    const accountId = await workspace();
    const first = await rpc().issueConnectLink(accountId, "user_ruben");
    const second = await rpc().issueConnectLink(accountId, "user_ruben");

    expect(await rpc().resolveConnectLink(first.token)).toBeNull();
    expect((await rpc().resolveConnectLink(second.token))?.state).toBe("active");
  });

  it("expires after seven days", async () => {
    const accountId = await workspace();
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");
    await cp((instance) => instance.sql.exec("UPDATE connect_links SET expires_at = ?", Date.now() - 1));

    expect((await rpc().resolveConnectLink(token))?.state).toBe("expired");
    expect((await rpc().getConnectLink(accountId))?.state).toBe("expired");
    expect(await rpc().exchangeConnectCodeForLink(token, "code", "state")).toBeNull();
  });

  it("carries the workspace's connect policy", async () => {
    const accountId = await workspace();
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");
    await rpc().setAccountBilling(accountId, { connectPolicy: "closed" });

    expect((await rpc().resolveConnectLink(token))?.connectPolicy).toBe("closed");
  });

  it("is spent by the first registration, into its own account", async () => {
    const accountId = await workspace();
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");
    mockGraph();
    await mintState(accountId, "state-1");

    const exchange = await rpc().exchangeConnectCodeForLink(token, "code", "state-1");
    expect(exchange?.result).toMatchObject({ ok: true, waba_id: "WABA_LINK" });
    expect(exchange?.grant).toMatchObject({ accountId, state: "used" });
    expect(exchange?.notify).toBe(true);
    expect(await cp((instance) => instance.ownsWaba(accountId, "WABA_LINK"))).toBe(true);
    expect(await rpc().getConnectLink(accountId)).toMatchObject({
      state: "connected",
      connectedPhone: "+34 600 000 222",
    });

    await mintState(accountId, "state-2");
    expect(await rpc().exchangeConnectCodeForLink(token, "code", "state-2")).toBeNull();
    expect((await rpc().resolveConnectLink(token))?.state).toBe("used");
  });

  it("stays usable after a failed exchange, and reports each failure reason once", async () => {
    const accountId = await workspace();
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ error: { message: "bad code" } }), { status: 400 }),
    );

    await mintState(accountId, "state-1");
    const first = await rpc().exchangeConnectCodeForLink(token, "code", "state-1");
    expect(first?.result).toMatchObject({ ok: false, code: "failed" });
    expect(first?.notify).toBe(true);

    await mintState(accountId, "state-2");
    const second = await rpc().exchangeConnectCodeForLink(token, "code", "state-2");
    expect(second?.result.ok).toBe(false);
    expect(second?.notify).toBe(false);
    expect((await rpc().resolveConnectLink(token))?.state).toBe("active");
  });

  it("does not report an exchange that never reached Meta", async () => {
    const accountId = await workspace();
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");

    const exchange = await rpc().exchangeConnectCodeForLink(token, "code", "never-minted");
    expect(exchange?.result).toMatchObject({ ok: false, code: "state" });
    expect(exchange?.notify).toBe(false);
  });

  it("refuses a state minted for another workspace", async () => {
    const accountId = await workspace();
    const other = await workspace("org_other");
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");
    mockGraph();
    await mintState(other, "foreign-state");

    const exchange = await rpc().exchangeConnectCodeForLink(token, "code", "foreign-state");
    expect(exchange?.result).toMatchObject({ ok: false, code: "state" });
    expect(await cp((instance) => instance.ownsWaba(other, "WABA_LINK"))).toBe(false);
  });

  it("lets only one exchange hold the link at a time", async () => {
    const accountId = await workspace();
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");

    expect(await cp((instance) => instance.claimConnectLink(token))).not.toBeNull();
    expect(await cp((instance) => instance.claimConnectLink(token))).toBeNull();
    await cp((instance) => instance.settleConnectLink(token, { connected: false, code: "failed" }));
    expect(await cp((instance) => instance.claimConnectLink(token))).not.toBeNull();
  });

  it("fails closed when the workspace's organization link is not active", async () => {
    const accountId = await workspace();
    const { token } = await rpc().issueConnectLink(accountId, "user_ruben");
    await cp((instance) => instance.sql.exec("UPDATE organization_accounts SET status = 'disabled'"));

    expect(await rpc().resolveConnectLink(token)).toBeNull();
    expect(await rpc().exchangeConnectCodeForLink(token, "code", "state")).toBeNull();
  });
});
