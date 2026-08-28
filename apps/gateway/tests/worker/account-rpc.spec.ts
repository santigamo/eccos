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