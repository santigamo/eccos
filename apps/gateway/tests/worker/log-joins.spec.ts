import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { bootstrapAccount, gatewayStub } from "./helpers";

afterEach(async () => {
  await reset();
});

beforeEach(async () => {
  await bootstrapAccount();
});

/**
 * THE JOINS THE OPERATOR CONSOLE COULD NOT MAKE (eccos-9ty).
 *
 * Three tables held the whole story of one message and shared no keys the
 * reader could follow: an event's forwarding batch was only implied by a
 * matching `received_at`, and the wamid that ties a status callback to the send
 * it is about was printed on two screens and joined on neither.
 *
 * `inbound_events.delivery_id` is the new key; the rest is read-time joining.
 * `WhatsAppCallbackEvent` — the public forwarding contract — is untouched, and
 * every added column is additive and nullable.
 */

const REPLY: WhatsAppCallbackEvent = {
  type: "reply",
  from: "34600000000",
  messageId: "wamid.M1",
  text: "hola",
  at: 1_700_000_000_000,
};

function statusEvent(
  type: "delivered" | "read",
  wamid: string,
  at: number,
): WhatsAppCallbackEvent {
  return { type, transportMessageId: wamid, at };
}

describe("ingest links every event to the batch that carries it", () => {
  it("stamps the delivery id inside the same transaction", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([REPLY, statusEvent("delivered", "wamid.O1", 1)]);
      const rows = i.listInbound();
      const batches = new Set(rows.map((row) => row.delivery_id));
      // One ingest is one batch, and BOTH events name it — the link is a
      // column now, not a coincidence of timestamps.
      expect(batches.size).toBe(1);
      expect([...batches][0]).toBeTypeOf("number");
      expect(rows.every((row) => row.delivery_event_count === 2)).toBe(true);
    });
  });

  it("an all-duplicate callback creates no batch and re-links nothing", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([REPLY]);
      const first = i.listInbound()[0]?.delivery_id;
      // Meta re-delivers; `INSERT OR IGNORE` drops the row, and no second
      // forward may be enqueued — the subscriber would receive it twice.
      i.ingest([REPLY]);
      expect(i.listDeliveries()).toHaveLength(1);
      // The duplicate keeps the batch that actually carried it, which is the
      // honest answer to "where did my receiver get this".
      expect(i.listInbound()[0]?.delivery_id).toBe(first);
    });
  });

  it("batch ids stay gapless, because the console shows them as `#N`", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([REPLY]);
      i.ingest([REPLY]); // all duplicates: no batch
      i.ingest([statusEvent("delivered", "wamid.O1", 1)]);
      expect(i.listDeliveries().map((row) => row.id).sort()).toEqual([1, 2]);
    });
  });
});

describe("listInbound resolves both joins", () => {
  it("carries the batch's state, attempts and moment", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([REPLY]);
      const [batch] = i.listDeliveries();
      i.sql.exec(
        "UPDATE deliveries SET status='failed', attempts=6, last_error=?, finished_at=? WHERE id=?",
        "subscriber returned 502",
        1_700_000_009_000,
        batch?.id,
      );
      const row = i.listInbound()[0];
      expect(row?.delivery_status).toBe("failed");
      expect(row?.delivery_attempts).toBe(6);
      expect(row?.delivery_last_error).toBe("subscriber returned 502");
      expect(row?.delivery_finished_at).toBe(1_700_000_009_000);
    });
  });

  it("a status event names the outbound message it is about", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const request = JSON.stringify({
        to: "34600000000",
        type: "template",
        template: { name: "cita_encontrada", language: { code: "es" } },
      });
      i.logOutbound("wamid.O1", "34600000000", request, "sent", null, "PNID1");
      i.ingest([statusEvent("delivered", "wamid.O1", 1_700_000_005_000)]);
      const row = i.listInbound()[0];
      expect(row?.outbound_id).toBe(1);
      expect(row?.outbound_request).toBe(request);
    });
  });

  it("a reply never claims to be about one of our sends", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      // A reply carries `message_id`, not `transport_message_id`, so the wamid
      // join must miss — SQL's NULL != NULL is what guarantees it, and this
      // pins that the column list did not accidentally join on the wrong one.
      i.logOutbound(null, "34600000000", "{}", "failed", '{"code":1}', "PNID1");
      i.ingest([REPLY]);
      expect(i.listInbound()[0]?.outbound_id ?? null).toBeNull();
    });
  });

  it("filters by kind and by the batch's state", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([REPLY]);
      i.ingest([statusEvent("delivered", "wamid.O1", 2)]);
      const [oldest] = i.listDeliveries({ status: "pending" }).slice(-1);
      i.sql.exec("UPDATE deliveries SET status='delivered' WHERE id=?", oldest?.id);

      expect(i.listInbound({ type: "reply" }).map((row) => row.type)).toEqual(["reply"]);
      // The delivery-state filter runs on the JOINED table, so an event with no
      // batch is excluded rather than counted as waiting.
      expect(i.listInbound({ deliveryStatus: "delivered" }).map((row) => row.type)).toEqual([
        "reply",
      ]);
      expect(i.listInbound({ deliveryStatus: "pending" }).map((row) => row.type)).toEqual([
        "delivered",
      ]);
    });
  });

  it("pages backwards through the `before` cursor", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      for (let n = 0; n < 3; n++) {
        i.ingest([statusEvent("delivered", `wamid.${n}`, n)]);
      }
      const first = i.listInbound({ limit: 2 });
      expect(first.map((row) => row.id)).toEqual([3, 2]);
      const older = i.listInbound({ limit: 2, before: first.at(-1)?.id });
      expect(older.map((row) => row.id)).toEqual([1]);
    });
  });
});

describe("listOutbound hangs the trail off each message", () => {
  it("returns the status callbacks in order, with Meta's own timestamps", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.logOutbound("wamid.O1", "34600000000", "{}", "sent", null, "PNID1");
      i.ingest([statusEvent("delivered", "wamid.O1", 1_700_000_005_000)]);
      i.ingest([statusEvent("read", "wamid.O1", 1_700_000_006_000)]);
      const trail = i.listOutbound()[0]?.trail;
      expect(trail?.map((event) => event.type)).toEqual(["delivered", "read"]);
      // The EVENT's own `at`, not `received_at`: the two differ by the
      // callback's flight time, and the first is what an operator compares
      // against a customer's screenshot.
      expect(trail?.[0]?.at).toBe(1_700_000_005_000);
      expect(trail?.[0]?.deliveryStatus).toBe("pending");
    });
  });

  it("carries the Graph error code of a failed status", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.logOutbound("wamid.O1", "34600000000", "{}", "sent", null, "PNID1");
      i.ingest([
        {
          type: "failed",
          transportMessageId: "wamid.O1",
          at: 1,
          errorCode: "131047",
          errorMessage: "Re-engagement message",
        },
      ]);
      expect(i.listOutbound()[0]?.trail?.[0]?.errorCode).toBe("131047");
    });
  });

  it("a refused send has an empty trail — no wamid, nothing to be about", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.logOutbound(null, "34600000000", "{}", "failed", '{"code":131047}', "PNID1");
      expect(i.listOutbound()[0]?.trail).toEqual([]);
    });
  });

  it("filters by what Meta answered", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.logOutbound("wamid.O1", "34600000000", "{}", "sent", null, "PNID1");
      i.logOutbound(null, "34600000000", "{}", "failed", "{}", "PNID1");
      expect(i.listOutbound({ status: "failed" }).map((row) => row.status)).toEqual(["failed"]);
    });
  });
});

describe("getCounts splits inbound by kind", () => {
  it("tells a customer writing in from a receipt for our own send", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.ingest([statusEvent("delivered", "wamid.O1", 1), statusEvent("delivered", "wamid.O2", 2)]);
      const counts = i.getCounts();
      // THE MISREAD THIS ENDS: the flat total says "2 inbound events" on a
      // workspace where nobody wrote in.
      expect(counts.inbound).toBe(2);
      expect(counts.inboundByType).toEqual({ delivered: 2 });
      expect(counts.inboundByType?.reply ?? 0).toBe(0);
    });
  });
});
