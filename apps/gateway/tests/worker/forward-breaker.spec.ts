/**
 * The forward drain's time budget and the per-WABA circuit breaker, plus the subscriber
 * answer time stored on each delivery. The clock is `Date.now` under test control, and
 * the subscriber is a fetch mock that moves it, so nothing here sleeps.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIRCUIT_BACKOFF_MS,
  CIRCUIT_THRESHOLD,
  type EccosGateway,
  FORWARD_BUDGET_MS,
} from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import {
  alarmOf,
  bootstrapAccount,
  gatewayStub,
  holdAlarms,
  runAlarm,
  SUBSCRIBER_URL,
  TEST_ACCOUNT_ID,
  TEST_WABA_ID,
} from "./helpers";

let clock = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

beforeEach(async () => {
  await bootstrapAccount();
  await holdAlarms();
  await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL });
  clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

function rpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

async function seedDue(count: number) {
  await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
    for (let n = 0; n < count; n++) {
      i.sql.exec(
        `INSERT INTO deliveries (payload, status, attempts, next_attempt_at, created_at) VALUES (?, 'pending', 0, ?, ?)`,
        JSON.stringify({ events: [{ type: "delivered", transportMessageId: `wamid.B${n}`, at: 1 }] }),
        clock,
        clock,
      );
    }
  });
}

/** A subscriber that takes `ms` of the test clock to give each answer. */
function subscriber(answer: () => Response | Promise<Response>, ms = 0) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    clock += ms;
    return answer();
  });
}

const status = (code: number) => () => new Response("x", { status: code });

async function deliveries() {
  return runInDurableObject(gatewayStub(), (i: EccosGateway) =>
    i.sql.exec("SELECT id, status, attempts, last_duration_ms FROM deliveries ORDER BY id").toArray() as Array<{
      id: number;
      status: string;
      attempts: number;
      last_duration_ms: number | null;
    }>,
  );
}

async function subscriberConfig() {
  return rpc().getSubscriberConfig(TEST_WABA_ID, TEST_ACCOUNT_ID);
}

async function alarmAt() {
  return runInDurableObject(gatewayStub(), (_i: EccosGateway, state: DurableObjectState) => state.storage.getAlarm());
}

/** An alarm armed in the past fires (held, so a no-op) at once and reads back as null. */
async function expectWakeNow() {
  expect((await alarmAt()) ?? clock).toBeLessThanOrEqual(clock);
}

describe("forward time budget", () => {
  it("stops starting rows past the budget, runs the rest of the alarm, and leaves the rest to the next wakes", async () => {
    await seedDue(40);
    const fetchMock = subscriber(status(200), 1_500);
    const media = vi.fn();

    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const step = i as unknown as { mediaStep: (now: number) => Promise<number | null> };
      const mediaStep = step.mediaStep.bind(i);
      step.mediaStep = async (now) => {
        media();
        return mediaStep(now);
      };
      await alarmOf(i);
    });

    // Six start at once and each answer moves the clock 1.5 s, so the budget runs out
    // before the next six: every row started before it, none after.
    const started = fetchMock.mock.calls.length;
    expect(started).toBeGreaterThanOrEqual(6);
    expect(started).toBeLessThanOrEqual(Math.ceil(FORWARD_BUDGET_MS / 1_500) + 6);
    // The steps after the drain still ran in the same wake.
    expect(media).toHaveBeenCalledOnce();
    // The rows left are due, so the next wake is now.
    await expectWakeNow();

    for (let wake = 0; wake < 10 && (await deliveries()).some((row) => row.status === "pending"); wake++) {
      await runAlarm();
    }
    expect((await deliveries()).every((row) => row.status === "delivered" && row.attempts === 1)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });

  it("drains a fast subscriber's whole batch in one wake", async () => {
    await seedDue(40);
    const fetchMock = subscriber(status(200), 50);
    await runAlarm();
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });
});

describe("forward circuit breaker", () => {
  it(`opens after ${CIRCUIT_THRESHOLD} failures in a row, and not before`, async () => {
    await seedDue(CIRCUIT_THRESHOLD - 1);
    subscriber(status(503));
    await runAlarm();
    expect(await subscriberConfig()).toMatchObject({ circuitOpenUntil: null, consecutiveFailures: CIRCUIT_THRESHOLD - 1 });

    await seedDue(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAlarm();
    expect(await subscriberConfig()).toMatchObject({
      circuitOpenUntil: clock + CIRCUIT_BACKOFF_MS[0],
      consecutiveFailures: CIRCUIT_THRESHOLD,
    });
    const opened = warn.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .find((line) => line.event === "circuit_open");
    expect(opened).toMatchObject({ area: "forward", failures: CIRCUIT_THRESHOLD, openUntil: clock + CIRCUIT_BACKOFF_MS[0] });
    expect(opened.wabaId).toContain(TEST_WABA_ID);
    // The alert went through the throttle: the next one inside the window is held back.
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      expect(i.recordOpsAlert("circuit", clock)).toEqual({ send: false, count: 1 });
    });
  });

  it.each([
    ["5xx", status(500)],
    ["429", status(429)],
    ["a timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ["a network error", () => Promise.reject(new TypeError("Network connection lost."))],
  ])("counts %s", async (_name, answer) => {
    await seedDue(CIRCUIT_THRESHOLD);
    subscriber(answer);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAlarm();
    expect((await subscriberConfig()).circuitOpenUntil).toBe(clock + CIRCUIT_BACKOFF_MS[0]);
  });

  it("does not count a 4xx payload rejection, and an answer resets the count", async () => {
    await seedDue(CIRCUIT_THRESHOLD - 1);
    subscriber(status(503));
    await runAlarm();
    await seedDue(CIRCUIT_THRESHOLD + 1);
    subscriber(status(400));
    await runAlarm();
    expect(await subscriberConfig()).toMatchObject({ circuitOpenUntil: null, consecutiveFailures: 0 });
  });

  it("spends no attempt while open, and re-arms for the probe", async () => {
    await seedDue(8);
    const fetchMock = subscriber(status(503));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAlarm();
    // Six were in flight when the fifth failure opened it; the other two never started.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const openUntil = clock + CIRCUIT_BACKOFF_MS[0];
    expect(await alarmAt()).toBe(openUntil);

    const before = await deliveries();
    clock += 10_000;
    await runAlarm();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(await deliveries()).toEqual(before);
    expect(before.filter((row) => row.attempts === 0)).toHaveLength(2);
    expect(before.every((row) => row.status === "pending")).toBe(true);
    expect(await alarmAt()).toBe(openUntil);
  });

  it("sends one probe once the pause is over; a failed probe spends its attempt and doubles the pause", async () => {
    await seedDue(12);
    const fetchMock = subscriber(status(503));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAlarm();
    const pauses: number[] = [];
    for (let trip = 1; trip < CIRCUIT_BACKOFF_MS.length + 1; trip++) {
      const { circuitOpenUntil } = await subscriberConfig();
      clock = circuitOpenUntil as number;
      const calls = fetchMock.mock.calls.length;
      const attempts = (await deliveries()).reduce((sum, row) => sum + row.attempts, 0);
      await runAlarm();
      expect(fetchMock.mock.calls.length - calls).toBe(1);
      expect((await deliveries()).reduce((sum, row) => sum + row.attempts, 0)).toBe(attempts + 1);
      pauses.push(((await subscriberConfig()).circuitOpenUntil as number) - clock);
    }
    expect(pauses).toEqual([...CIRCUIT_BACKOFF_MS.slice(1), CIRCUIT_BACKOFF_MS.at(-1)]);
  });

  it("closes on a successful probe and drains the rest", async () => {
    await seedDue(8);
    const fetchMock = subscriber(status(503));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAlarm();
    clock += CIRCUIT_BACKOFF_MS[0];
    fetchMock.mockImplementation(async () => new Response("ok", { status: 200 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAlarm();
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(await subscriberConfig()).toMatchObject({ circuitOpenUntil: null, consecutiveFailures: 0 });
    const closed = log.mock.calls.map(([line]) => JSON.parse(String(line))).find((line) => line.event === "circuit_closed");
    expect(closed).toMatchObject({ area: "forward", reason: "answered", failures: 6 });
    // The rest are due (their retry backoff ran out during the pause), so the drain resumes at once.
    await expectWakeNow();
    await runAlarm();
    expect((await deliveries()).every((row) => row.status === "delivered")).toBe(true);
  });

  it("closes when the operator saves the target", async () => {
    await seedDue(CIRCUIT_THRESHOLD);
    subscriber(status(503));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAlarm();
    expect((await subscriberConfig()).circuitOpenUntil).not.toBeNull();

    await rpc().setSubscriberConfig({ url: "https://fixed.example/hook" }, TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(await subscriberConfig()).toMatchObject({ circuitOpenUntil: null, consecutiveFailures: 0 });
  });

  it("closes on a manual retry of one delivery or of a window", async () => {
    await seedDue(CIRCUIT_THRESHOLD);
    subscriber(status(503));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAlarm();
    await rpc().retryDelivery(1, TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(await subscriberConfig()).toMatchObject({ circuitOpenUntil: null, consecutiveFailures: 0 });

    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.sql.exec("UPDATE deliveries SET next_attempt_at = 0");
      await alarmOf(i);
      i.sql.exec("UPDATE deliveries SET status = 'failed'");
      expect(i.forwardCircuit().openUntil).toBeGreaterThan(0);
      i.retryFailedDeliveries(0, clock);
      expect(i.forwardCircuit()).toEqual({ failures: 0, trips: 0, openUntil: 0 });
    });
  });
});

describe("delivery duration", () => {
  it("stores each attempt's answer time and reports it on the subscriber read", async () => {
    await seedDue(1);
    subscriber(status(503), 1_234);
    await runAlarm();
    expect((await deliveries())[0]?.last_duration_ms).toBe(1_234);
    expect((await subscriberConfig()).lastForward?.durationMs).toBe(1_234);
  });

  it("summarises the newest rows' answer times", async () => {
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      // Older than the 50 newest rows, so left out.
      i.sql.exec(
        "INSERT INTO deliveries (payload, status, next_attempt_at, created_at, last_duration_ms) VALUES ('{}', 'delivered', 0, 0, 99999)",
      );
      for (let ms = 1; ms <= 49; ms++) {
        i.sql.exec(
          "INSERT INTO deliveries (payload, status, next_attempt_at, created_at, last_duration_ms) VALUES ('{}', 'delivered', 0, 0, ?)",
          ms * 100,
        );
      }
      // Not tried yet: no sample.
      i.sql.exec("INSERT INTO deliveries (payload, status, next_attempt_at, created_at) VALUES ('{}', 'pending', 0, 0)");
    });
    const config = await subscriberConfig();
    expect(config.latency).toEqual({ p50Ms: 2_500, p95Ms: 4_700, samples: 49 });
    expect(config.lastForward?.durationMs).toBeNull();
  });
});
