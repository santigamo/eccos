import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import type { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { EVENTS_PAGE_DEFAULT, EVENTS_PAGE_MAX } from "../../src/events-query";
import {
  bootstrapAccount,
  gatewayStub,
  holdAlarms,
  runAlarm,
  SUBSCRIBER_SECRET,
  SUBSCRIBER_URL,
  TEST_ACCOUNT_ID,
  TEST_WABA_ID,
} from "./helpers";

type Page = {
  ok: boolean;
  events: Array<{ id: number; receivedAt: number; event: WhatsAppCallbackEvent }>;
  next: number | null;
};

let apiKey = "";

beforeEach(async () => {
  apiKey = (await bootstrapAccount()).apiKey;
  await holdAlarms();
});

afterEach(async () => {
  delete (env as { READ_RATE_LIMITER?: RateLimit }).READ_RATE_LIMITER;
  vi.restoreAllMocks();
  await reset();
});

const reply = (i: number): WhatsAppCallbackEvent => ({
  type: "reply",
  from: "34600000000",
  messageId: `wamid.IN${i}`,
  text: `m${i}`,
  at: 1_700_000_000_000 + i,
  phoneNumberId: "PNID1",
});

const delivered = (i: number): WhatsAppCallbackEvent => ({
  type: "delivered",
  transportMessageId: `wamid.OUT${i}`,
  at: 1_700_000_000_000 + i,
  phoneNumberId: "PNID1",
});

const ingest = (events: WhatsAppCallbackEvent[], wabaId = TEST_WABA_ID) =>
  getGatewayStubForWaba(env, wabaId).ingest(events);

function list(query = "", key = apiKey, wabaId = TEST_WABA_ID) {
  return exports.default.fetch(`http://example.com/v1/wabas/${wabaId}/events${query}`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

async function page(query = ""): Promise<Page> {
  const res = await list(query);
  expect(res.status).toBe(200);
  return res.json();
}

/** Follows `next` from the start, as a poller would, returning every page. */
async function drain(params = ""): Promise<Page[]> {
  const pages = [await page(`?${params}`)];
  while (pages.at(-1)!.next !== null) pages.push(await page(`?${params}&after=${pages.at(-1)!.next}`));
  return pages;
}

const messageIds = (pages: Page[]) =>
  pages.flatMap((p) => p.events.map(({ event }) => ("messageId" in event ? event.messageId : event.type)));

describe("GET /v1/wabas/:wabaId/events", () => {
  it("pages through every event once, in id order", async () => {
    await ingest(Array.from({ length: 250 }, (_, i) => reply(i)));
    const pages = await drain("limit=100");
    expect(pages.map((p) => p.events.length)).toEqual([100, 100, 50]);
    expect(messageIds(pages)).toEqual(Array.from({ length: 250 }, (_, i) => `wamid.IN${i}`));
    const ids = pages.flatMap((p) => p.events.map((e) => e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(pages[0]!.next).toBe(pages[0]!.events.at(-1)!.id);
  });

  it("ends an exact multiple of the limit without an extra empty page, and resumes with new events", async () => {
    await ingest(Array.from({ length: 200 }, (_, i) => reply(i)));
    const pages = await drain("limit=100");
    expect(pages.map((p) => p.events.length)).toEqual([100, 100]);
    const last = pages[1]!.events.at(-1)!.id;
    expect(await page(`?after=${last}`)).toEqual({ ok: true, events: [], next: null });
    await ingest([reply(200)]);
    expect(messageIds([await page(`?after=${last}`)])).toEqual(["wamid.IN200"]);
  });

  it("starts at the oldest event still held when after predates retention", async () => {
    await ingest(Array.from({ length: 5 }, (_, i) => reply(i)));
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.sql.exec("DELETE FROM inbound_events WHERE id <= 3");
    });
    const body = await page("?after=1");
    expect(body.events.map((e) => e.id)).toEqual([4, 5]);
    expect(body.next).toBeNull();
  });

  it("since starts at the first event received at or after it", async () => {
    await ingest([reply(0), reply(1), reply(2)]);
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.sql.exec("UPDATE inbound_events SET received_at = id * 1000");
    });
    expect((await page("?since=2000")).events.map((e) => [e.id, e.receivedAt])).toEqual([
      [2, 2000],
      [3, 3000],
    ]);
    expect((await page("?since=1500")).events.map((e) => e.id)).toEqual([2, 3]);
    expect((await page("?since=1000&after=2")).events.map((e) => e.id)).toEqual([3]);
    expect(await page("?since=3001")).toEqual({ ok: true, events: [], next: null });
  });

  it("type keeps one event type, and pages within it", async () => {
    await ingest(Array.from({ length: 6 }, (_, i) => (i % 2 ? delivered(i) : reply(i))));
    const pages = await drain("type=delivered&limit=2");
    expect(pages.map((p) => p.events.length)).toEqual([2, 1]);
    expect(pages.flatMap((p) => p.events.map(({ event }) => event.type))).toEqual(["delivered", "delivered", "delivered"]);
  });

  it("defaults the page size and caps a larger limit", async () => {
    await ingest(Array.from({ length: EVENTS_PAGE_MAX + 1 }, (_, i) => reply(i)));
    const byDefault = await page();
    expect(byDefault.events).toHaveLength(EVENTS_PAGE_DEFAULT);
    const capped = await page(`?limit=${EVENTS_PAGE_MAX * 10}`);
    expect(capped.events).toHaveLength(EVENTS_PAGE_MAX);
    expect(capped.next).toBe(capped.events.at(-1)!.id);
  });

  it("answers 400 to an invalid parameter", async () => {
    for (const query of ["after=-1", "after=abc", "after=1.5", "after=", "since=yesterday", "type=bogus", "type=", "limit=0", "limit=-5", "limit=ten", "limit="]) {
      const res = await list(`?${query}`);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false });
    }
  });

  it("answers 404 for another account's WABA and an unknown one", async () => {
    const other = await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PN_OTHER" }]);
    await ingest([reply(1)], "WABA_OTHER");
    for (const wabaId of ["WABA_OTHER", "WABA_NOPE"]) {
      const res = await list("", apiKey, wabaId);
      expect(res.status, wabaId).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "WABA is not configured" });
    }
    const own = await list("", other.apiKey, "WABA_OTHER");
    expect(((await own.json()) as Page).events).toHaveLength(1);
  });

  it("returns each event exactly as the webhook forwards it", async () => {
    const forwarded: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === SUBSCRIBER_URL) forwarded.push(...JSON.parse(String(init?.body)).events);
      return new Response("ok");
    });
    await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL, SUBSCRIBER_SECRET: SUBSCRIBER_SECRET });
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: TEST_WABA_ID,
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "PNID1" },
            contacts: [{ wa_id: "34600000000", profile: { name: "Ana" } }],
            messages: [{ from: "34600000000", id: "wamid.IN", timestamp: "1700000000", type: "text", text: { body: "hi" } }],
            statuses: [{ id: "wamid.OUT", status: "read", timestamp: "1700000001", recipient_id: "34600000000" }],
          },
        }],
      }],
    });
    const res = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    await runAlarm();
    expect(forwarded).toHaveLength(2);
    expect((await page()).events.map((e) => e.event)).toEqual(forwarded);
  });

  it("checks READ_RATE_LIMITER per account and WABA when bound, and logs one safe line", async () => {
    await ingest([reply(1)]);
    const log = vi.spyOn(console, "log");
    const limit = vi.fn(async () => ({ success: false }));
    (env as { READ_RATE_LIMITER?: RateLimit }).READ_RATE_LIMITER = { limit };
    const limited = await list();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, error: "rate limited" });
    expect(limit).toHaveBeenCalledWith({ key: `${TEST_ACCOUNT_ID}:${TEST_WABA_ID}` });

    limit.mockResolvedValue({ success: true });
    await page();
    const lines = log.mock.calls
      .map(([arg]) => JSON.parse(String(arg)))
      .filter((line) => line.event === "events_list");
    expect(lines).toMatchObject([
      { status: 429, wabaId: TEST_WABA_ID },
      { status: 200, wabaId: TEST_WABA_ID, count: 1, hasMore: false },
    ]);
    expect(JSON.stringify(lines)).not.toContain("wamid.IN1");
  });
});
