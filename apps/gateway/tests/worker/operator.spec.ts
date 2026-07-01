import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { singletonStub } from "./helpers";

afterEach(async () => {
  await reset();
});

function makeRpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

/** 1 inbound reply (+1 pending delivery), 2 outbound (1 sent, 1 failed), 4 config keys. */
async function seed() {
  await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
    i.saveConfig({
      META_WABA_ID: "WABA1",
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
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const rows = i.listInbound();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: "reply", message_id: "wamid.M1" });
      expect(typeof rows[0]!.id).toBe("number");
    });
  });

  it("listOutbound returns both sent and failed with full columns", async () => {
    await seed();
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const rows = i.listOutbound();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status).sort()).toEqual(["failed", "sent"]);
      expect(rows[0]).toHaveProperty("request");
    });
  });

  it("listDeliveries includes all statuses (unlike snapshot) and filters by status", async () => {
    await seed();
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      expect(i.listDeliveries()).toHaveLength(1);
      expect(i.listDeliveries({ status: "pending" })).toHaveLength(1);
      expect(i.listDeliveries({ status: "delivered" })).toHaveLength(0);
    });
  });

  it("getDelivery returns a row or null", async () => {
    await seed();
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const [d] = i.listDeliveries();
      expect(i.getDelivery(d!.id)?.id).toBe(d!.id);
      expect(i.getDelivery(999_999)).toBeNull();
    });
  });

  it("getCounts aggregates by status", async () => {
    await seed();
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      const c = i.getCounts();
      expect(c.inbound).toBe(1);
      expect(c.outbound).toEqual({ sent: 1, failed: 1 });
      expect(c.deliveries).toEqual({ pending: 1 });
    });
  });

  it("retryDelivery re-enqueues a failed delivery and resets attempts", async () => {
    await seed();
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
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
});

describe("GatewayRPC", () => {
  it("getStatus reports health, connection and counts", async () => {
    await seed();
    const status = await makeRpc().getStatus();
    expect(status.name).toBe("eccos");
    expect(status.health).toBe("degraded"); // 1 failed outbound, 0 failed deliveries
    expect(status.connection).toMatchObject({
      wabaId: "WABA1",
      phoneNumberId: "PNID1",
      displayPhone: "+34600000000",
    });
    expect(status.counts.inbound).toBe(1);
  });

  it("listDeliveries + retryDelivery work over RPC", async () => {
    await seed();
    const rpc = makeRpc();
    const deliveries = await rpc.listDeliveries();
    expect(deliveries).toHaveLength(1);
    expect((await rpc.retryDelivery(deliveries[0]!.id)).ok).toBe(true);
  });
});
