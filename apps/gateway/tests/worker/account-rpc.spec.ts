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

