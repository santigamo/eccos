import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  runBoundedPool,
  type EccosGateway,
} from "../../src/gateway";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { gatewayStub } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function seedPendingDelivery(event: WhatsAppCallbackEvent) {
  await gatewayStub().ingest([event]);
}

async function seedPendingDeliveries(events: WhatsAppCallbackEvent[]) {
  await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
    const now = Date.now();
    for (const event of events) {
      instance.sql.exec(
        `INSERT INTO deliveries (payload, status, attempts, next_attempt_at, created_at)
         VALUES (?, 'pending', 0, ?, ?)`,
        JSON.stringify({ events: [event] }),
        now,
        now,
      );
    }
  });
}

async function runGatewayAlarm() {
  await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
    await instance.alarm();
  });
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

describe("EccosGateway alarm concurrency", () => {
  it("uses a 5-second timeout for subscriber requests", async () => {
    await seedPendingDelivery({
      type: "delivered",
      transportMessageId: "wamid.TIMEOUT",
      at: 1_700_000_000_000,
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await runGatewayAlarm();

    expect(timeout).toHaveBeenCalledWith(5_000);
  });

  it("cancels subscriber response bodies", async () => {
    await seedPendingDelivery({
      type: "delivered",
      transportMessageId: "wamid.BODY",
      at: 1_700_000_000_000,
    });
    const response = new Response("ok", { status: 200 });
    const body = response.body;
    if (!body) throw new Error("expected a response body");
    const cancel = vi.spyOn(body, "cancel");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await runGatewayAlarm();

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("caps alarm subscriber fetches at six while draining a larger batch", async () => {
    const events: WhatsAppCallbackEvent[] = Array.from({ length: 12 }, (_, i) => ({
      type: "reply",
      from: "34600000000",
      messageId: `wamid.LIMIT${i}`,
      text: `row ${i}`,
      at: 1_700_000_000_000,
    }));
    await seedPendingDeliveries(events);

    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      inFlight++;
      calls++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return new Response("ok", { status: 200 });
    });

    await runGatewayAlarm();

    expect(calls).toBe(events.length);
    expect(peak).toBe(6);
    expect(inFlight).toBe(0);
  });

  it("continues forwarding when one subscriber request fails", async () => {
    const events: WhatsAppCallbackEvent[] = Array.from({ length: 12 }, (_, i) => ({
      type: "reply",
      from: "34600000000",
      messageId: `wamid.FAIL${i}`,
      text: `row ${i}`,
      at: 1_700_000_000_000,
    }));
    await seedPendingDeliveries(events);

    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("subscriber unavailable");
      return new Response("ok", { status: 200 });
    });

    await runGatewayAlarm();

    expect(calls).toBe(events.length);
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const rows = instance.sql
        .exec("SELECT status, last_error FROM deliveries ORDER BY id")
        .toArray() as Array<{ status: string; last_error: string | null }>;
      expect(rows.filter((row) => row.status === "delivered")).toHaveLength(events.length - 1);
      expect(rows.filter((row) => row.last_error === "subscriber unavailable")).toHaveLength(1);
    });
  });

  it("anchors retry backoff to the end of the attempt", async () => {
    const event: WhatsAppCallbackEvent = {
      type: "delivered",
      transportMessageId: "wamid.BACKOFFANCHOR",
      at: 1_700_000_000_000,
    };
    await seedPendingDelivery(event);

    const T0 = Date.now();
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const v = calls++ === 0 ? T0 : T0 + 60_000;
      return v;
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fail", { status: 500 }));

    await runGatewayAlarm();
    vi.mocked(Date.now).mockRestore();

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const row = instance.sql
        .exec("SELECT status, attempts, next_attempt_at FROM deliveries ORDER BY id DESC LIMIT 1")
        .toArray()[0] as { status: string; attempts: number; next_attempt_at: number };
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at).toBeGreaterThanOrEqual(T0 + 64_500);
      expect(row.next_attempt_at).toBeLessThanOrEqual(T0 + 65_500);
    });
  });
});

describe("runBoundedPool", () => {
  it("runs every item exactly once and caps concurrency at the limit", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];

    await runBoundedPool(items, 6, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      done.push(item);
    });

    expect(peak).toBeLessThanOrEqual(6);
    expect(done.sort((a, b) => a - b)).toEqual(items);
  });

  it("keeps slots full: 12 items drain through a 6-worker pool", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    let ran = 0;

    await runBoundedPool(items, 6, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      ran++;
    });

    expect(ran).toBe(12);
    expect(peak).toBe(6);
  });

  it("does not cancel the other rows when one worker fails", async () => {
    const items = Array.from({ length: 4 }, (_, i) => i);
    const attempted: number[] = [];
    const failure = new Error("subscriber exploded");

    await expect(
      runBoundedPool(items, 2, async (item) => {
        attempted.push(item);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (item === 1) throw failure;
      }),
    ).rejects.toThrow("subscriber exploded");

    expect(attempted.sort()).toEqual(items);
  });

  it("waits for all workers before propagating a storage failure", async () => {
    const items = Array.from({ length: 4 }, (_, i) => i);
    let completed = 0;
    const failure = new Error("storage error");

    await expect(
      runBoundedPool(items, 2, async (item) => {
        if (item === 0) throw failure;
        completed++;
      }),
    ).rejects.toThrow("storage error");

    expect(completed).toBe(3);
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
