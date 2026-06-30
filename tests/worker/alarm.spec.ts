import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffMs, EccosGateway } from "../../worker/gateway";
import type { WhatsAppCallbackEvent } from "../../src/core/types";
import { singletonStub } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function seedPendingDelivery(event: WhatsAppCallbackEvent) {
  await singletonStub().ingest([event]);
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

    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      await instance.alarm();
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === env.SUBSCRIBER_WEBHOOK_URL),
    ).toBe(true);

    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
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

    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      await instance.alarm();
    });
    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      await instance.alarm();
    });

    const subscriberCalls = fetchMock.mock.calls.filter(([url]) => String(url) === env.SUBSCRIBER_WEBHOOK_URL);
    expect(subscriberCalls).toHaveLength(1);

    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
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
    await runDurableObjectAlarm(singletonStub());

    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
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
    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      const row = instance.sql
        .exec("SELECT id FROM deliveries ORDER BY id DESC LIMIT 1")
        .toArray()[0] as { id: number };
      instance.sql.exec("UPDATE deliveries SET next_attempt_at = ? WHERE id = ?", Date.now(), row.id);
    });

    for (let i = 0; i < 3; i++) {
      await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
        instance.sql.exec("UPDATE deliveries SET next_attempt_at = ? WHERE status = 'pending'", Date.now());
      });
      await runDurableObjectAlarm(singletonStub());
    }

    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      const row = instance.sql
        .exec("SELECT status, attempts FROM deliveries ORDER BY id DESC LIMIT 1")
        .toArray()[0] as { status: string; attempts: number };
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(3);
    });
  });

  it("deletes terminal deliveries older than 30 days (D3)", async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      instance.sql.exec(
        `INSERT INTO deliveries (payload, status, attempts, last_error, next_attempt_at, created_at)
         VALUES (?, 'delivered', 1, NULL, ?, ?)`,
        JSON.stringify({ events: [] }),
        old,
        old,
      );
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await seedPendingDelivery({
      type: "delivered",
      transportMessageId: "wamid.RETENTION",
      at: 1_700_000_000_000,
    });

    await runDurableObjectAlarm(singletonStub());

    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      const stale = instance.sql
        .exec("SELECT COUNT(*) AS c FROM deliveries WHERE created_at < ?", Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toArray()[0]!.c;
      expect(stale).toBe(0);
    });
  });
});

describe("backoffMs", () => {
  it("uses exponential backoff capped at 1 hour", () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(25_000);
    expect(backoffMs(3)).toBe(125_000);
    expect(backoffMs(6)).toBe(3_600_000);
  });
});
