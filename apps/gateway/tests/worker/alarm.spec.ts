import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffMs, type EccosGateway } from "../../src/gateway";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { gatewayStub } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function seedPendingDelivery(event: WhatsAppCallbackEvent) {
  await gatewayStub().ingest([event]);
}

describe("EccosGateway alarm", () => {
  it("delivers pending rows and forwards D13 headers on 2xx", async () => {
    const event: WhatsAppCallbackEvent = {
      type: "reply",
      from: "34600000000",
      messageId: "wamid.ALARM",
      text: "Hola",
      at: 1_700_000_000_000,
    };
    await seedPendingDelivery(event);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === env.SUBSCRIBER_WEBHOOK_URL) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-eccos-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
        expect(headers.get("x-webhook-event")).toBe("reply");
        expect(headers.get("x-idempotency-key")).toMatch(/^[0-9a-f]{64}$/);
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      await instance.alarm();
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === env.SUBSCRIBER_WEBHOOK_URL),
    ).toBe(true);

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const row = instance.sql.exec("SELECT status FROM deliveries ORDER BY id DESC LIMIT 1").toArray()[0];
      expect(row?.status).toBe("delivered");
    });
  });

  it("does not duplicate externally-visible delivery when alarm runs twice", async () => {
    const event: WhatsAppCallbackEvent = {
      type: "reply",
      from: "34600000000",
      messageId: "wamid.IDEMPOTENT",
      text: "Only once",
      at: 1_700_000_000_000,
    };
    await seedPendingDelivery(event);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === env.SUBSCRIBER_WEBHOOK_URL) {
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      await instance.alarm();
    });
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      await instance.alarm();
    });

    const subscriberCalls = fetchMock.mock.calls.filter(([url]) => String(url) === env.SUBSCRIBER_WEBHOOK_URL);
    expect(subscriberCalls).toHaveLength(1);

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const row = instance.sql
        .exec("SELECT status, attempts FROM deliveries ORDER BY id DESC LIMIT 1")
        .toArray()[0] as { status: string; attempts: number };
      expect(row.status).toBe("delivered");
      expect(row.attempts).toBe(1);
    });
  });

  it("increments attempts and schedules backoff on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fail", { status: 500 }));
    const event: WhatsAppCallbackEvent = {
      type: "delivered",
      transportMessageId: "wamid.RETRY",
      at: 1_700_000_000_000,
    };

    await seedPendingDelivery(event);

    const before = Date.now();
    await runDurableObjectAlarm(gatewayStub());

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const row = instance.sql
        .exec("SELECT status, attempts, next_attempt_at FROM deliveries ORDER BY id DESC LIMIT 1")
        .toArray()[0] as { status: string; attempts: number; next_attempt_at: number };
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at).toBeGreaterThanOrEqual(before + 4_500);
      expect(row.next_attempt_at).toBeLessThanOrEqual(before + 6_000);
    });
  });

  it("marks delivery failed after FORWARD_MAX_ATTEMPTS", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fail", { status: 500 }));
    const event: WhatsAppCallbackEvent = {
      type: "delivered",
      transportMessageId: "wamid.FAIL",
      at: 1_700_000_000_000,
    };

    await seedPendingDelivery(event);
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const row = instance.sql
        .exec("SELECT id FROM deliveries ORDER BY id DESC LIMIT 1")
        .toArray()[0] as { id: number };
      instance.sql.exec("UPDATE deliveries SET next_attempt_at = ? WHERE id = ?", Date.now(), row.id);
    });

    for (let i = 0; i < 3; i++) {
      await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
        instance.sql.exec("UPDATE deliveries SET next_attempt_at = ? WHERE status = 'pending'", Date.now());
      });
      await runDurableObjectAlarm(gatewayStub());
    }

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const row = instance.sql
        .exec("SELECT status, attempts FROM deliveries ORDER BY id DESC LIMIT 1")
        .toArray()[0] as { status: string; attempts: number };
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(3);
    });
  });

  // A failed delivery has to say WHY it failed: a missing subscriber URL and a
  // destination that rejects are opposite diagnoses, and an operator reading the
  // queue can only act on them if last_error tells them apart.
  it("records the upstream status code as the failure reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 502 }));
    await seedPendingDelivery({
      type: "delivered",
      transportMessageId: "wamid.REASON502",
      at: 1_700_000_000_000,
    });

    await runDurableObjectAlarm(gatewayStub());

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const row = instance.sql
        .exec("SELECT last_error FROM deliveries ORDER BY id DESC LIMIT 1")
        .toArray()[0] as { last_error: string };
      expect(row.last_error).toBe("subscriber returned 502");
    });
  });

  it("distinguishes a missing subscriber URL from a rejecting subscriber", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await seedPendingDelivery({
      type: "delivered",
      transportMessageId: "wamid.NOURL",
      at: 1_700_000_000_000,
    });

    // Empty string in DO config wins over the env fallback, exercising the real
    // "operator cleared the forwarding target" path rather than mutating env.
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      instance.saveConfig({ SUBSCRIBER_WEBHOOK_URL: "" });
    });

    await runDurableObjectAlarm(gatewayStub());

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const row = instance.sql
        .exec("SELECT last_error FROM deliveries ORDER BY id DESC LIMIT 1")
        .toArray()[0] as { last_error: string };
      expect(row.last_error).toBe("no subscriber URL configured");
    });
    // Nothing was sent: with no target there is no request to make.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Retention (split content/delivery windows + redaction) is covered in
  // tests/worker/retention.spec.ts.
});

describe("backoffMs", () => {
  it("uses exponential backoff capped at 1 hour", () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(25_000);
    expect(backoffMs(3)).toBe(125_000);
    expect(backoffMs(6)).toBe(3_600_000);
  });
});
