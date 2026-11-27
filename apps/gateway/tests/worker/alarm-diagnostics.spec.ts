/**
 * The alarm's diagnostic log lines: step timings, slow steps, the media batch and slow
 * downloads. `Date.now` is under test control and the fetch mocks move it, so nothing sleeps.
 */
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { ALARM_SLOW_MS, type EccosGateway, SLOW_STEP_MS } from "../../src/gateway";
import { alarmOf, bootstrapAccount, gatewayStub, holdAlarms, runAlarm, SUBSCRIBER_URL } from "./helpers";

const BYTES = "fake-jpeg-bytes";
const LOOKASIDE = "https://lookaside.example/cdn";

let clock = 0;
let warn: MockInstance;
let log: MockInstance;

beforeEach(async () => {
  await bootstrapAccount();
  await holdAlarms();
  clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function lines(spy: MockInstance, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === event);
}

const reply: WhatsAppCallbackEvent = { type: "reply", from: "34600000000", messageId: "wamid.DIAG", text: "Hola", at: 1 };

function image(mediaId: string): WhatsAppCallbackEvent {
  return {
    type: "message",
    from: "34600000001",
    messageId: `wamid.${mediaId}`,
    at: Date.now(),
    phoneNumberId: "PNID1",
    messageType: "image",
    media: { id: mediaId, mimeType: "image/jpeg" },
  };
}

/** A subscriber that takes `ms` to answer. */
function slowSubscriber(ms: number) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== SUBSCRIBER_URL) return new Response("not found", { status: 404 });
    clock += ms;
    return new Response("ok");
  });
}

describe("alarm timings", () => {
  it("logs alarm_slow with each step's time, and alarm_step_slow for the slow step", async () => {
    await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL });
    await gatewayStub().ingest([reply]);
    slowSubscriber(ALARM_SLOW_MS + 1_000);

    await runAlarm();

    expect(lines(warn, "alarm_step_slow")).toEqual([expect.objectContaining({ area: "alarm", step: "drain", ms: 6_000 })]);
    expect(lines(warn, "alarm_slow")).toEqual([
      expect.objectContaining({
        area: "alarm",
        totalMs: 6_000,
        billingHold: 0,
        drain: 6_000,
        sweep: 0,
        activation: 0,
        sync: 0,
        scheduled: 0,
        broadcast: 0,
        media: 0,
        rearm: 0,
        wakeArrived: false,
        dueMedia: 0,
      }),
    ]);
  });

  it("logs a slow step at once, without alarm_slow while the total stays under 5 s", async () => {
    await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL });
    await gatewayStub().ingest([reply]);
    slowSubscriber(SLOW_STEP_MS);

    await runAlarm();

    expect(lines(warn, "alarm_step_slow")).toEqual([expect.objectContaining({ step: "drain", ms: SLOW_STEP_MS })]);
    expect(lines(warn, "alarm_slow")).toEqual([]);
  });

  it("is silent on a fast alarm", async () => {
    await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL });
    await gatewayStub().ingest([reply]);
    slowSubscriber(0);

    await runAlarm();

    expect(lines(warn, "alarm_step_slow")).toEqual([]);
    expect(lines(warn, "alarm_slow")).toEqual([]);
  });

  it("awaits the re-arm, at the earliest wake", async () => {
    await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL });
    const retryAt = clock + 60_000;
    const armed = await runInDurableObject(gatewayStub(), async (instance: EccosGateway, state: DurableObjectState) => {
      instance.sql.exec(
        `INSERT INTO deliveries (payload, status, attempts, next_attempt_at, created_at) VALUES (?, 'pending', 1, ?, ?)`,
        JSON.stringify({ events: [reply] }),
        retryAt,
        clock,
      );
      await state.storage.deleteAlarm();
      const setAlarm = state.storage.setAlarm.bind(state.storage);
      // Moves the clock only once the call is awaited, so an unawaited re-arm measures 0.
      const spy = vi.spyOn(state.storage, "setAlarm").mockImplementation(async (at) => {
        await Promise.resolve();
        clock += SLOW_STEP_MS;
        return setAlarm(at);
      });
      await alarmOf(instance);
      expect(spy).toHaveBeenCalledTimes(1);
      return state.storage.getAlarm();
    });

    expect(armed).toBe(retryAt);
    expect(lines(warn, "alarm_step_slow")).toEqual([expect.objectContaining({ step: "rearm", ms: SLOW_STEP_MS })]);
  });

  it("flushes storage instead when nothing needs another wake", async () => {
    const calls = await runInDurableObject(gatewayStub(), async (instance: EccosGateway, state: DurableObjectState) => {
      await state.storage.deleteAlarm();
      const setAlarm = vi.spyOn(state.storage, "setAlarm");
      const sync = vi.spyOn(state.storage, "sync");
      await alarmOf(instance);
      return { setAlarm: setAlarm.mock.calls.length, sync: sync.mock.calls.length, armed: await state.storage.getAlarm() };
    });

    expect(calls).toEqual({ setAlarm: 0, sync: 1, armed: null });
  });
});

/** A Meta that takes `ms` per download: `lookup` answers the Graph id lookup, `cdn` the bytes. */
function fakeMeta(ms: number, lookup?: () => Response, cdn: () => Response = () => new Response(BYTES)) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://graph.facebook.com/")) {
      const mediaId = url.split("/").pop();
      if (lookup) clock += ms;
      return lookup?.() ?? Response.json({ url: `${LOOKASIDE}/${mediaId}`, mime_type: "image/jpeg", file_size: BYTES.length, id: mediaId });
    }
    if (url.startsWith(LOOKASIDE)) {
      clock += ms;
      return cdn();
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

describe("media diagnostics", () => {
  it("logs the batch, each download's start and a slow download, with no URL or token", async () => {
    fakeMeta(SLOW_STEP_MS + 500);
    await gatewayStub().ingest([image("9001")]);

    await runAlarm();

    expect(lines(log, "media_batch_start")).toEqual([expect.objectContaining({ area: "media", dueMedia: 1 })]);
    expect(lines(log, "media_download_start")).toEqual([expect.objectContaining({ area: "media", mediaId: "9001", attempt: 1 })]);
    expect(lines(warn, "media_download_slow")).toEqual([
      expect.objectContaining({ area: "media", mediaId: "9001", ms: 3_500, state: "stored", size: BYTES.length }),
    ]);
    expect(lines(warn, "alarm_step_slow")).toEqual([expect.objectContaining({ step: "media", ms: 3_500 })]);
    expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toMatch(/lookaside|tenant-token/);
  });

  it("logs a slow failed or given-up download with no size", async () => {
    // Gone first: it is never due again, so the second alarm downloads only the new id.
    fakeMeta(SLOW_STEP_MS, () => new Response("gone", { status: 404 }));
    await gatewayStub().ingest([image("9003")]);
    await runAlarm();
    fakeMeta(SLOW_STEP_MS, undefined, () => new Response("busy", { status: 503 }));
    await gatewayStub().ingest([image("9002")]);
    await runAlarm();

    expect(lines(warn, "media_download_slow")).toEqual([
      expect.objectContaining({ mediaId: "9003", ms: SLOW_STEP_MS, state: "gone", size: null }),
      expect.objectContaining({ mediaId: "9002", ms: SLOW_STEP_MS, state: "failed", size: null }),
    ]);
  });

  it("does not log a fast download as slow", async () => {
    fakeMeta(SLOW_STEP_MS - 1);
    await gatewayStub().ingest([image("9004")]);

    await runAlarm();

    expect(lines(log, "media_download_start")).toHaveLength(1);
    expect(lines(warn, "media_download_slow")).toEqual([]);
  });

  it("logs no batch when no media is due", async () => {
    await runAlarm();

    expect(lines(log, "media_batch_start")).toEqual([]);
  });
});
