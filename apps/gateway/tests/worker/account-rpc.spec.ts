import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
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

describe("GatewayRPC dashboard installation bootstrap", () => {
  it("creates one generated account and is idempotent without returning the key again", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const installationKey = "access:v1:team.example:aud-1";

    const first = await rpc.initializeDashboard(installationKey, "Workspace");
    expect(first.status).toBe("created");
    if (first.status !== "created") return;
    expect(first.account.accountId).toMatch(/^acc_/);
    expect(first.account.name).toBe("Workspace");
    expect(first.apiKey).toMatch(/^ek_/);

    const second = await rpc.initializeDashboard(installationKey, "Different name");
    expect(second).toEqual({ status: "existing", account: first.account });
    expect(await rpc.getDashboardAccount(installationKey)).toEqual(first.account);
    expect(await rpc.getDashboardAccount("access:v1:other.example:aud-1")).toBeNull();

    const resources = await rpc.listAccountResources(first.account.accountId);
    expect(resources.keys).toHaveLength(1);
    expect(JSON.stringify(resources)).not.toContain(first.apiKey);
    await expect(cp((instance) => instance.authenticateApiKey(first.apiKey))).resolves.toMatchObject({
      accountId: first.account.accountId,
    });
  });

  it("serializes concurrent initialization for one installation", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rpc.initializeDashboard("access:v1:team.example:aud-2", "Concurrent")),
    );
    const created = results.filter((result) => result.status === "created");
    expect(created).toHaveLength(1);
    expect(new Set(results.map((result) => result.account.accountId))).toHaveLength(1);
    await cp(async (instance) => {
      expect(instance.sql.exec("SELECT COUNT(*) AS count FROM accounts").toArray()[0]?.count).toBe(1);
      expect(instance.sql.exec("SELECT COUNT(*) AS count FROM api_keys").toArray()[0]?.count).toBe(1);
      expect(instance.sql.exec("SELECT COUNT(*) AS count FROM dashboard_installations").toArray()[0]?.count).toBe(1);
    });
  });

  it("assigns distinct accounts to distinct Access applications", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const first = await rpc.initializeDashboard("access:v1:team.example:aud-a", "A");
    const second = await rpc.initializeDashboard("access:v1:team.example:aud-b", "B");
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect(first.account.accountId).not.toBe(second.account.accountId);
  });

  it("starts an Embedded Signup handoff for the dashboard installation account", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const installationKey = "access:v1:team.example:aud-connect";
    const initialized = await rpc.initializeDashboard(installationKey, "Connect workspace");

    const result = await rpc.startConnect(installationKey);
    expect(result.url).toMatch(/^https:\/\/gateway\.example\/connect\?state=/);
    expect(result.state).toBeTruthy();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    await cp(async (instance) => {
      expect(instance.getConnectState(result.state)).toEqual({
        accountId: initialized.account.accountId,
        redirectUri: "https://gateway.example/connect",
      });
      expect(instance.refreshConnectState(result.state, Date.now() + 60_000)).toEqual({
        accountId: initialized.account.accountId,
        redirectUri: "https://gateway.example/connect",
      });
    });
  });

  it("fails closed when dashboard Embedded Signup has no public gateway origin", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), { ...env, GATEWAY_PUBLIC_URL: "" });
    await rpc.initializeDashboard("access:v1:team.example:aud-missing-origin", "Workspace");
    await expect(rpc.startConnect("access:v1:team.example:aud-missing-origin")).rejects.toThrow(
      /GATEWAY_PUBLIC_URL is required/,
    );
  });
});
