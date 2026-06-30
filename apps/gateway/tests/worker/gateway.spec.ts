import { env } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { EccosGateway } from "../../src/gateway";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { singletonStub } from "./helpers";

afterEach(async () => {
  await reset();
});

describe("EccosGateway", () => {
  it("ingest([delivered]) inserts 1 inbound_events + 1 deliveries", async () => {
    const event: WhatsAppCallbackEvent = {
      type: "delivered",
      transportMessageId: "wamid.D",
      at: 1_700_000_000_000,
    };
    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      const result = instance.ingest([event]);
      expect(result.received).toBe(1);
      const inbound = instance.sql.exec("SELECT COUNT(*) AS c FROM inbound_events").toArray()[0]!.c;
      const deliveries = instance.sql.exec("SELECT COUNT(*) AS c FROM deliveries").toArray()[0]!.c;
      expect(inbound).toBe(1);
      expect(deliveries).toBe(1);
    });
  });

  it("dedups identical delivered events (D12)", async () => {
    const event: WhatsAppCallbackEvent = {
      type: "delivered",
      transportMessageId: "wamid.D",
      at: 1_700_000_000_000,
    };
    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      instance.ingest([event]);
      instance.ingest([event]);
      const inbound = instance.sql.exec("SELECT COUNT(*) AS c FROM inbound_events").toArray()[0]!.c;
      const deliveries = instance.sql.exec("SELECT COUNT(*) AS c FROM deliveries").toArray()[0]!.c;
      expect(inbound).toBe(1);
      expect(deliveries).toBe(1);
    });
  });

  it("dedups duplicate replies with the same messageId", async () => {
    const reply: WhatsAppCallbackEvent = {
      type: "reply",
      from: "34600000000",
      messageId: "wamid.M",
      text: "Hola",
      at: 1_700_000_000_000,
    };
    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      instance.ingest([reply, reply]);
      const inbound = instance.sql.exec("SELECT COUNT(*) AS c FROM inbound_events").toArray()[0]!.c;
      const deliveries = instance.sql.exec("SELECT COUNT(*) AS c FROM deliveries").toArray()[0]!.c;
      expect(inbound).toBe(1);
      expect(deliveries).toBe(1);
    });
  });

  it("logOutbound inserts into outbound_messages", async () => {
    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      instance.logOutbound("wamid.OUT", "34600000000", '{"to":"34600000000"}', "sent", null);
      const rows = instance.sql
        .exec(
          "SELECT transport_message_id, recipient, status FROM outbound_messages ORDER BY id DESC LIMIT 1",
        )
        .toArray();
      expect(rows[0]).toMatchObject({
        transport_message_id: "wamid.OUT",
        recipient: "34600000000",
        status: "sent",
      });
    });
  });

  it("saveConfig + getConfigValue round-trip", async () => {
    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      instance.saveConfig({ META_PHONE_NUMBER_ID: "PNID" });
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBe("PNID");
    });
  });
});
