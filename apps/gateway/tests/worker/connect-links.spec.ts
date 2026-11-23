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

/** A new link for the account, replacing any other. */
async function issue(accountId: string) {
  const issued = await rpc().issueConnectLink(accountId, "user_ruben", true);
  if (typeof issued === "string") throw new Error(`link not issued: ${issued}`);
  return issued;
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

/** Takes the link as an exchange does; fails the test when it cannot. */
async function claim(token: string) {
  const claimed = await rpc().claimConnectLink(token);
  if (!claimed || claimed === "busy" || !claimed.claimId) throw new Error("link not claimed");
  return claimed.claimId;
}

describe("connection links", () => {
  it("stores the selector and a hash, never the token", async () => {
    const accountId = await workspace();
    const { token, expiresAt } = await issue(accountId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{43}$/);
    expect(expiresAt - Date.now()).toBeGreaterThan(CONNECT_LINK_TTL_MS - 5_000);

    const stored = JSON.stringify(await cp((instance) => instance.sql.exec("SELECT * FROM connect_links").toArray()));
    expect(stored).not.toContain(token.split(".")[1]);
  });

  it("resolves to the account it was made for, and only with the whole secret", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    const [selector, secret] = token.split(".") as [string, string];

    expect(await rpc().resolveConnectLink(token)).toEqual({
      linkId: selector,
      accountId,
      organizationId: "org_agency",
      creatorUserId: "user_ruben",
      state: "active",
      connectPolicy: "open",
    });
    const flipped = `${selector}.${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    expect(await rpc().resolveConnectLink(flipped)).toBeNull();
    expect(await rpc().resolveConnectLink(selector)).toBeNull();
    expect(await rpc().resolveConnectLink("")).toBeNull();
  });

  it("resolving changes nothing; the link reads as opened only once the caller says so", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);

    const grant = await rpc().resolveConnectLink(token);
    expect((await rpc().getConnectLink(accountId))?.state).toBe("pending");
    await rpc().markConnectLinkOpened(grant?.linkId ?? "");
    expect((await rpc().getConnectLink(accountId))?.state).toBe("opened");
  });

  it("keeps one live link per workspace: a new one revokes the previous, whose row stays", async () => {
    const accountId = await workspace();
    const first = await issue(accountId);
    const second = await issue(accountId);

    expect((await rpc().resolveConnectLink(first.token))?.state).toBe("revoked");
    expect(await rpc().claimConnectLink(first.token)).toMatchObject({ claimId: null, grant: { state: "revoked" } });
    expect((await rpc().resolveConnectLink(second.token))?.state).toBe("active");
    expect(await cp((instance) => instance.sql.exec("SELECT COUNT(*) AS n FROM connect_links").one().n)).toBe(2);
  });

  it("makes one link when two callers ask for the first at once", async () => {
    const accountId = await workspace();
    const [first, second] = await Promise.all([
      rpc().issueConnectLink(accountId, "user_ruben"),
      rpc().issueConnectLink(accountId, "user_ruben"),
    ]);
    const issued = [first, second].filter((answer) => typeof answer !== "string");
    expect(issued).toHaveLength(1);
    expect([first, second]).toContain("exists");
  });

  it("expires after seven days", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    await cp((instance) => instance.sql.exec("UPDATE connect_links SET expires_at = ?", Date.now() - 1));

    expect((await rpc().resolveConnectLink(token))?.state).toBe("expired");
    expect((await rpc().getConnectLink(accountId))?.state).toBe("expired");
    expect(await rpc().claimConnectLink(token)).toMatchObject({ claimId: null });
  });

  it("carries the workspace's connect policy", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    await rpc().setAccountBilling(accountId, { connectPolicy: "closed" });

    expect((await rpc().resolveConnectLink(token))?.connectPolicy).toBe("closed");
  });

  it("is spent by the first registration, into its own account", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    mockGraph();
    await mintState(accountId, "state-1");

    const exchange = await rpc().exchangeConnectCodeForClaim(await claim(token), "code", "state-1");
    expect(exchange).toMatchObject({ result: { ok: true, waba_id: "WABA_LINK" }, notify: true, state: "connected" });
    expect(await cp((instance) => instance.ownsWaba(accountId, "WABA_LINK"))).toBe(true);
    expect(await rpc().getConnectLink(accountId)).toMatchObject({
      state: "connected",
      connectedPhone: "+34 600 000 222",
      creatorUserId: "user_ruben",
    });
    expect(await rpc().claimConnectLink(token)).toMatchObject({ claimId: null, grant: { state: "used" } });
  });

  it("stays usable after a failed exchange", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ error: { message: "bad code" } }), { status: 400 }),
    );
    await mintState(accountId, "state-1");

    const exchange = await rpc().exchangeConnectCodeForClaim(await claim(token), "code", "state-1");
    expect(exchange).toMatchObject({ result: { ok: false, code: "failed" }, notify: true, state: "pending" });
    expect(await claim(token)).toEqual(expect.any(String));
  });

  it("mails each failure reason once, however the reasons alternate, and a few per link at most", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    const attempt = async (code: "owned" | "no_waba" | "denied" | "failed" | "subscription_required" | "state") =>
      (await rpc().settleConnectLink(await claim(token), { kind: "failed", code }))?.notify;

    expect(await attempt("state")).toBe(false);
    expect(await attempt("owned")).toBe(true);
    expect(await attempt("no_waba")).toBe(true);
    expect(await attempt("owned")).toBe(false);
    expect(await attempt("no_waba")).toBe(false);
    expect(await attempt("denied")).toBe(true);
    expect(await attempt("failed")).toBe(false);
    expect(await attempt("subscription_required")).toBe(false);
  });

  it("refuses a state minted for another workspace", async () => {
    const accountId = await workspace();
    const other = await workspace("org_other");
    const { token } = await issue(accountId);
    mockGraph();
    await mintState(other, "foreign-state");

    const exchange = await rpc().exchangeConnectCodeForClaim(await claim(token), "code", "foreign-state");
    expect(exchange?.result).toMatchObject({ ok: false, code: "state" });
    expect(await cp((instance) => instance.ownsWaba(other, "WABA_LINK"))).toBe(false);
  });

  it("treats a failure once the registration write has started as unknown, not as a retry", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    const gateway = rpc();
    vi.spyOn(gateway, "exchangeConnectCodeForAccountId").mockResolvedValue({
      ok: false,
      error: "provisioning kick failed",
      code: "failed",
      partial: true,
    });

    const exchange = await gateway.exchangeConnectCodeForClaim(await claim(token), "code", "state-1");
    expect(exchange).toEqual({ result: null, notify: true, state: "unconfirmed" });
    expect((await rpc().getConnectLink(accountId))?.state).toBe("unconfirmed");
    expect(await rpc().claimConnectLink(token)).toMatchObject({ claimId: null });
  });

  it("reports a failure after the registration write began as partial", async () => {
    const accountId = await workspace();
    mockGraph();
    await mintState(accountId, "state-1");
    await cp((instance) => {
      instance.beginWabaProvisioningBatch = async () => {
        throw new Error("storage went away");
      };
    });

    expect(await rpc().exchangeConnectCodeForAccountId(accountId, "code", "state-1")).toMatchObject({
      ok: false,
      code: "failed",
      partial: true,
    });
  });

  it("a policy refusal wrote nothing, so it is a clean failure", async () => {
    const accountId = await workspace();
    mockGraph();
    await mintState(accountId, "state-clean");
    await rpc().setAccountBilling(accountId, { connectPolicy: "closed" });
    const refused = await rpc().exchangeConnectCodeForAccountId(accountId, "code", "state-clean");
    expect(refused).toMatchObject({ ok: false, code: "subscription_required" });
    expect((refused as { partial?: true }).partial).toBeUndefined();
  });

  it("keeps the link usable when the exchange throws before Meta is called", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    const gateway = new GatewayRPC(createExecutionContext(), { ...env, GATEWAY_PUBLIC_URL: "" });

    const exchange = await gateway.exchangeConnectCodeForClaim(await claim(token), "code", "state-1");
    expect(exchange).toMatchObject({ result: { ok: false, code: "failed" }, state: "pending" });
    expect((await rpc().resolveConnectLink(token))?.state).toBe("active");
  });

  it("holds the link against a second bearer for the whole exchange, well past any real one", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    const held = await claim(token);

    expect(await rpc().claimConnectLink(token)).toBe("busy");
    const until = await cp((instance) => instance.sql.exec("SELECT claimed_until FROM connect_links").one().claimed_until);
    expect((until as number) - Date.now()).toBeGreaterThan(5 * 60 * 1000);
    await rpc().settleConnectLink(held, { kind: "failed", code: "failed" });
    expect(await claim(token)).toEqual(expect.any(String));
  });

  it("a late settle still records its number after the link was replaced", async () => {
    const accountId = await workspace();
    const old = await issue(accountId);
    const held = await claim(old.token);
    const next = await issue(accountId);

    expect(await rpc().settleConnectLink(held, { kind: "connected", phone: "+34 600 000 222" })).toEqual({
      notify: true,
      state: "connected",
    });
    const row = await cp(
      (instance) =>
        instance.sql.exec("SELECT connected_phone FROM connect_links WHERE selector = ?", old.token.split(".")[0]).one(),
    );
    expect(row.connected_phone).toBe("+34 600 000 222");
    expect((await rpc().resolveConnectLink(next.token))?.state).toBe("active");
  });

  it("a late settle still lands after its claim ran out and another exchange took the link", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    const first = await claim(token);
    await cp((instance) => instance.sql.exec("UPDATE connect_links SET claimed_until = ?", Date.now() - 1));
    const second = await claim(token);

    expect(await rpc().settleConnectLink(first, { kind: "connected", phone: "+34 1" })).toMatchObject({ state: "connected" });
    // The second exchange's hold was not the first's to release, and it cannot spend the link on a guess any more.
    expect(await rpc().settleConnectLink(second, { kind: "unknown" })).toEqual({ notify: false, state: "connected" });
  });

  it("only the exchange that holds the link can spend it as unconfirmed", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    const held = await claim(token);
    const [selector] = token.split(".");

    expect(await rpc().settleConnectLink(`${selector}.not-the-claim`, { kind: "unknown" })).toEqual({
      notify: false,
      state: "pending",
    });
    expect(await rpc().settleConnectLink("nothing.here", { kind: "unknown" })).toBeNull();
    expect(await rpc().settleConnectLink(held, { kind: "unknown" })).toEqual({ notify: true, state: "unconfirmed" });
    expect(await rpc().settleConnectLink(held, { kind: "unknown" })).toMatchObject({ notify: false });
    // A confirmation that arrives afterwards replaces the guess.
    expect(await rpc().settleConnectLink(held, { kind: "connected", phone: "+34 1" })).toMatchObject({ state: "connected" });
  });

  it("fails closed when the workspace's organization link is not active", async () => {
    const accountId = await workspace();
    const { token } = await issue(accountId);
    await cp((instance) => instance.sql.exec("UPDATE organization_accounts SET status = 'disabled'"));

    expect(await rpc().resolveConnectLink(token)).toBeNull();
    expect(await rpc().claimConnectLink(token)).toBeNull();
    expect(await cp((instance) => instance.sql.exec("SELECT claim_nonce FROM connect_links").one().claim_nonce)).toBeNull();
    expect((await rpc().getConnectLink(accountId))?.state).toBe("expired");
  });
});
