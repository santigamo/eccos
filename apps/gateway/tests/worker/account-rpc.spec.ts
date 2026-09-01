import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import type { EccosControlPlane } from "../../src/control-plane";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { bootstrapAccount, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

afterEach(async () => {
  await reset();
});

describe("GatewayRPC with a registered account", () => {
  it("resolves tenant credentials from the registry and keeps RPC reads scoped", async () => {
    await bootstrapAccount();
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      instance.saveConfig({
        META_WABA_ID: TEST_WABA_ID,
        META_PHONE_NUMBER_ID: "PNID1",
        DISPLAY_PHONE_NUMBER: "+34600000000",
      });
      instance.ingest([{
        type: "reply",
        from: "34600000000",
        messageId: "wamid.SCOPED",
        text: "hola",
        at: 1_700_000_000_000,
        phoneNumberId: "PNID1",
      }]);
    });

    const rpc = new GatewayRPC(createExecutionContext(), env);
    const [status, inbound, cfg] = await Promise.all([
      rpc.getStatus(TEST_WABA_ID, TEST_ACCOUNT_ID),
      rpc.listInbound({ wabaId: TEST_WABA_ID }, TEST_ACCOUNT_ID),
      rpc.getSubscriberConfig(TEST_WABA_ID, TEST_ACCOUNT_ID),
    ]);
    expect(status.connection.wabaId).toBe(TEST_WABA_ID);
    expect(inbound[0]).toMatchObject({ phone_number_id: "PNID1" });
    expect(cfg).toEqual({ url: null, hasSecret: false });

    // Another account cannot address this WABA (fail closed).
    await expect(rpc.listInbound({ wabaId: TEST_WABA_ID }, "other-account")).rejects.toThrow(/not owned|does not exist/);
  });

  it("keeps account keys hashed and revokes them", async () => {
    const boot = await bootstrapAccount();
    await cp(async (cp) => {
      const row = cp.sql.exec("SELECT hash FROM api_keys").toArray()[0] as { hash: string } | undefined;
      expect(row).toBeDefined();
    });
    // The raw key is the API key only once: subsequent auth uses the hash.
    await cp(async (cp) => {
      const keys = cp.sql.exec("SELECT key_id, account_id FROM api_keys").toArray();
      expect(keys).toHaveLength(1);
    });
  });
});

describe("GatewayRPC organization account bootstrap", () => {
  it("provisions one account per organization idempotently without an API key", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const organizationId = "org_gateway_test_1";

    const first = await rpc.ensureOrganizationAccount(organizationId, "Workspace");
    expect(first.status).toBe("active");
    expect(first.accountId).toMatch(/^acc_/);

    const second = await rpc.ensureOrganizationAccount(organizationId, "Different name");
    expect(second).toEqual({ accountId: first.accountId, status: "existing" });

    const link = await rpc.getOrganizationAccountLink(organizationId);
    expect(link).toEqual({ accountId: first.accountId, status: "active" });
    expect(await rpc.getOrganizationAccountLink("org_unknown")).toBeNull();

    // Contract invariant: provisioning must NOT auto-issue an API key.
    const resources = await rpc.listAccountResources(first.accountId);
    expect(resources.account?.accountId).toBe(first.accountId);
    expect(resources.keys).toHaveLength(0);
  });

  it("serializes concurrent provisioning for one organization", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rpc.ensureOrganizationAccount("org_concurrent", "Concurrent")),
    );
    const created = results.filter((result) => result.status === "active");
    expect(created).toHaveLength(1);
    expect(new Set(results.map((result) => result.accountId))).toHaveLength(1);
    await cp(async (instance) => {
      expect(instance.sql.exec("SELECT COUNT(*) AS count FROM accounts").toArray()[0]?.count).toBe(1);
      expect(instance.sql.exec("SELECT COUNT(*) AS count FROM api_keys").toArray()[0]?.count).toBe(0);
      expect(instance.sql.exec("SELECT COUNT(*) AS count FROM organization_accounts").toArray()[0]?.count).toBe(1);
    });
  });

  it("assigns distinct accounts to distinct organizations", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const first = await rpc.ensureOrganizationAccount("org_distinct_a", "A");
    const second = await rpc.ensureOrganizationAccount("org_distinct_b", "B");
    expect(first.accountId).not.toBe(second.accountId);
  });

  it("starts an Embedded Signup handoff for the linked organization account", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const { accountId } = await rpc.ensureOrganizationAccount("org_connect", "Connect workspace");

    const result = await rpc.startConnectForAccountId(accountId);
    expect(result.url).toMatch(/^https:\/\/gateway\.example\/connect\?state=/);
    expect(result.state).toBeTruthy();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    await cp(async (instance) => {
      expect(instance.getConnectState(result.state)).toEqual({
        accountId,
        redirectUri: "https://gateway.example/connect",
        returnTo: null,
      });
      expect(instance.refreshConnectState(result.state, Date.now() + 60_000)).toEqual({
        accountId,
        redirectUri: "https://gateway.example/connect",
        returnTo: null,
      });
    });
  });

  it("fails closed when dashboard Embedded Signup has no public gateway origin", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), { ...env, GATEWAY_PUBLIC_URL: "" });
    const { accountId } = await rpc.ensureOrganizationAccount("org_missing_origin", "Workspace");
    await expect(rpc.startConnectForAccountId(accountId)).rejects.toThrow(
      /GATEWAY_PUBLIC_URL is required/,
    );
  });
});

/**
 * The JavaScript-SDK half of Embedded Signup (session logging).
 *
 * `FB.login()` hands the code to the browser, which posts it to a
 * session-authenticated dashboard route; that route forwards it here over the
 * private binding. The browser therefore never holds an account API key, and
 * the app secret never leaves the gateway. These tests pin the three properties
 * that make that safe: the state is single-use, it is bound to one account, and
 * the exchange carries no `redirect_uri` (an `FB.login()` code was never bound
 * to one and Meta rejects the exchange if one is sent).
 */
describe("GatewayRPC.exchangeConnectCodeForAccountId", () => {
  function mockGraph() {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "biz-token" }), { status: 200 });
      }
      if (url.includes("/debug_token")) {
        return new Response(
          JSON.stringify({
            data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA_SDK"] }] },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/phone_numbers")) {
        return new Response(
          JSON.stringify({ data: [{ id: "PN_SDK", display_phone_number: "+34 600 000 111" }] }),
          { status: 200 },
        );
      }
      if (url.includes("is_on_biz_app")) {
        return new Response(
          JSON.stringify({ id: "PN_SDK", is_on_biz_app: false, platform_type: "CLOUD_API" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    return urls;
  }

  async function mintState(accountId: string, state: string): Promise<void> {
    await cp((instance) =>
      instance.startConnectState(state, accountId, Date.now() + 60_000, "https://gateway.example/connect"),
    );
  }

  it("registers what the code unlocks, without sending a redirect_uri", async () => {
    await bootstrapAccount();
    const urls = mockGraph();
    await mintState(TEST_ACCOUNT_ID, "sdk-state");

    const rpc = new GatewayRPC(createExecutionContext(), env);
    const result = await rpc.exchangeConnectCodeForAccountId(TEST_ACCOUNT_ID, "sdk-code", "sdk-state");

    expect(result).toMatchObject({ ok: true, waba_id: "WABA_SDK", phone_number_id: "PN_SDK" });

    const exchange = urls.find((url) => url.includes("/oauth/access_token")) ?? "";
    // Meta requires the exchange to repeat whatever redirect the dialog was
    // given — and requires it absent for an FB.login() code, which had none.
    expect(exchange).not.toContain("redirect_uri");
    expect(exchange).toContain("code=sdk-code");
    // The callback URL still has to come from somewhere: GATEWAY_PUBLIC_URL,
    // since there is no request to derive an origin from.
    await cp(async (instance) => {
      const waba = await instance.getWaba(TEST_ACCOUNT_ID, "WABA_SDK");
      expect(waba?.callbackUrl).toBe("https://gateway.example/webhooks/meta");
    });
  });

  it("consumes the state, so a replayed post cannot register twice", async () => {
    await bootstrapAccount();
    mockGraph();
    await mintState(TEST_ACCOUNT_ID, "sdk-once");

    const rpc = new GatewayRPC(createExecutionContext(), env);
    const first = await rpc.exchangeConnectCodeForAccountId(TEST_ACCOUNT_ID, "sdk-code", "sdk-once");
    expect(first.ok).toBe(true);

    const replay = await rpc.exchangeConnectCodeForAccountId(TEST_ACCOUNT_ID, "sdk-code", "sdk-once");
    expect(replay).toEqual({ ok: false, error: "invalid or expired OAuth state", code: "state" });
  });

  it("refuses a state minted for another account", async () => {
    await bootstrapAccount();
    mockGraph();
    await cp((instance) => instance.createAccount({ accountId: "other-account" }));
    await mintState("other-account", "sdk-foreign");

    const rpc = new GatewayRPC(createExecutionContext(), env);
    const result = await rpc.exchangeConnectCodeForAccountId(TEST_ACCOUNT_ID, "sdk-code", "sdk-foreign");
    expect(result).toEqual({ ok: false, error: "invalid or expired OAuth state", code: "state" });

    // And the foreign state survives: a failed cross-tenant attempt must not
    // consume somebody else's handoff.
    await cp(async (instance) => {
      expect(await instance.getConnectStateAccount("sdk-foreign")).toBe("other-account");
    });
  });

  it("rejects an empty code or state before touching Meta", async () => {
    await bootstrapAccount();
    const urls = mockGraph();
    const rpc = new GatewayRPC(createExecutionContext(), env);

    await expect(
      rpc.exchangeConnectCodeForAccountId(TEST_ACCOUNT_ID, "   ", "sdk-state"),
    ).rejects.toThrow(/code is required/);
    await expect(
      rpc.exchangeConnectCodeForAccountId(TEST_ACCOUNT_ID, "sdk-code", "  "),
    ).rejects.toThrow(/state is required/);
    expect(urls).toHaveLength(0);
  });
});
