import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { bootstrapAccount, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

afterEach(async () => {
  await reset();
});

// The gateway is account-scoped: every RPC call needs a control-plane account
// that owns the WABA. In these tests the WABA Durable Object is seeded directly
// and the account registry is bootstrapped; `GatewayRPC` resolves ownership and
// tenant credentials from the registry.
beforeEach(async () => {
  await bootstrapAccount();
});

function makeRpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

/** 1 inbound reply (+1 pending delivery), 2 outbound (1 sent, 1 failed), 4 config keys. */
async function seed() {
  await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
    i.saveConfig({
      META_WABA_ID: TEST_WABA_ID,
      META_PHONE_NUMBER_ID: "PNID1",
      DISPLAY_PHONE_NUMBER: "+34600000000",
      CONNECTED_AT: "1700000000000",
    });
    const reply: WhatsAppCallbackEvent = {
      type: "reply",
      from: "34600000000",
      messageId: "wamid.M1",
      text: "hola",
      at: 1_700_000_000_000,
    };
    i.ingest([reply]);
    i.logOutbound("wamid.O1", "34600000000", "{}", "sent", null);
    i.logOutbound(null, "34600000000", "{}", "failed", '{"code":1}');
  });
}

describe("EccosGateway operator reads", () => {
  it("listInbound returns full columns", async () => {
    await seed();
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const rows = i.listInbound();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: "reply", message_id: "wamid.M1" });
      expect(typeof rows[0]!.id).toBe("number");
    });
  });

  it("listOutbound returns both sent and failed with full columns", async () => {
    await seed();
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const rows = i.listOutbound();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status).sort()).toEqual(["failed", "sent"]);
      expect(rows[0]).toHaveProperty("request");
    });
  });

  it("listDeliveries includes all statuses (unlike snapshot) and filters by status", async () => {
    await seed();
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      expect(i.listDeliveries()).toHaveLength(1);
      expect(i.listDeliveries({ status: "pending" })).toHaveLength(1);
      expect(i.listDeliveries({ status: "delivered" })).toHaveLength(0);
    });
  });

  it("getDelivery returns a row or null", async () => {
    await seed();
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const [d] = i.listDeliveries();
      expect(i.getDelivery(d!.id)?.id).toBe(d!.id);
      expect(i.getDelivery(999_999)).toBeNull();
    });
  });

  it("getCounts aggregates by status", async () => {
    await seed();
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const c = i.getCounts();
      expect(c.inbound).toBe(1);
      expect(c.outbound).toEqual({ sent: 1, failed: 1 });
      expect(c.deliveries).toEqual({ pending: 1 });
    });
  });

  it("retryDelivery re-enqueues a failed delivery and resets attempts", async () => {
    await seed();
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const [d] = i.listDeliveries();
      i.sql.exec("UPDATE deliveries SET status='failed', attempts=6, last_error='boom' WHERE id=?", d!.id);
      expect(i.retryDelivery(d!.id)).toEqual({ ok: true, previousStatus: "failed" });
      const after = i.getDelivery(d!.id)!;
      expect(after.status).toBe("pending");
      expect(after.attempts).toBe(0);
      expect(after.last_error).toBeNull();
      expect(i.retryDelivery(999_999)).toEqual({ ok: false, previousStatus: null });
    });
  });

  it("exportData includes rows beyond the operator page limit", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.saveConfig({
        META_ACCESS_TOKEN: "export-token",
        META_APP_SECRET: "export-app-secret",
        SUBSCRIBER_SECRET: "export-subscriber-secret",
        __last_sweep_at__: "1700000000000",
        DISPLAY_PHONE_NUMBER: "+34600000000",
      });
      for (let n = 0; n < 205; n++) {
        i.logOutbound(`wamid.EXPORT_${n}`, "34600000000", "{}", "sent", null);
      }
      const exported = i.exportData();
      expect(exported.outbound).toHaveLength(205);
      expect(exported.outbound[0]?.transport_message_id).toBe("wamid.EXPORT_204");
      expect(exported.config).toMatchObject({ DISPLAY_PHONE_NUMBER: "+34600000000" });
      expect(exported.config).not.toHaveProperty("META_ACCESS_TOKEN");
      expect(exported.config).not.toHaveProperty("META_APP_SECRET");
      expect(exported.config).not.toHaveProperty("SUBSCRIBER_SECRET");
      expect(exported.config).not.toHaveProperty("__last_sweep_at__");
    });

    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.saveConfig({ META_ACCESS_TOKEN: "export-token" });
    });
    const exported = await makeRpc().exportData(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(exported.config).not.toHaveProperty("META_ACCESS_TOKEN");
    expect(exported.config).not.toHaveProperty("META_APP_SECRET");
    expect(exported.config).not.toHaveProperty("SUBSCRIBER_SECRET");
  });
});

describe("GatewayRPC", () => {
  it("getStatus reports health, connection and counts", async () => {
    await seed();
    const status = await makeRpc().getStatus(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(status.name).toBe("eccos");
    expect(status.health).toBe("degraded"); // 1 failed outbound, 0 failed deliveries
    expect(status.connection).toMatchObject({
      wabaId: TEST_WABA_ID,
      phoneNumberId: "PNID1",
      displayPhone: "+34600000000",
    });
    expect(status.counts.inbound).toBe(1);
  });

  it("listDeliveries + retryDelivery work over RPC", async () => {
    await seed();
    const rpc = makeRpc();
    const deliveries = await rpc.listDeliveries({ wabaId: TEST_WABA_ID }, TEST_ACCOUNT_ID);
    expect(deliveries).toHaveLength(1);
    expect((await rpc.retryDelivery(deliveries[0]!.id, TEST_WABA_ID, TEST_ACCOUNT_ID)).ok).toBe(true);
  });

  it("getConfig never returns private config values", async () => {
    await seed();
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.saveConfig({ SUBSCRIBER_SECRET: "subscriber-secret", META_ACCESS_TOKEN: "access-token" });
    });
    const config = await makeRpc().getConfig(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(config).toMatchObject({ META_WABA_ID: TEST_WABA_ID, META_PHONE_NUMBER_ID: "PNID1" });
    expect(config).not.toHaveProperty("SUBSCRIBER_SECRET");
    expect(config).not.toHaveProperty("META_ACCESS_TOKEN");
  });

  it("fails closed without an accountId and without a registered WABA", async () => {
    await seed();
    const rpc = makeRpc();
    const missingAccountError = await rpc
      .getStatus(TEST_WABA_ID, undefined as unknown as string)
      .then(() => null, (error) => error);
    expect(String(missingAccountError?.message ?? missingAccountError)).toMatch(/accountId is required/);
    // A different account that doesn't own this WABA fails closed.
    const foreignAccountError = await rpc
      .listInbound({ wabaId: TEST_WABA_ID }, "other-account")
      .then(() => null, (error) => error);
    expect(String(foreignAccountError?.message ?? foreignAccountError)).toMatch(/not owned|does not exist/);
  });
});
