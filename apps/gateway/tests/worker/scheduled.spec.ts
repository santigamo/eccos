import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import eventsMd from "../../../docs/src/content/docs/event-reference.md?raw";
import type { EccosGateway } from "../../src/gateway";
import { jsonFences } from "../docs-md";
import { bootstrapAccount, gatewayStub, holdAlarms, runAlarm, SUBSCRIBER_SECRET, SUBSCRIBER_URL, TEST_WABA_ID } from "./helpers";

let API_KEY = "";
const BASE = `http://example.com/v1/wabas/${TEST_WABA_ID}/scheduled`;
const PHONE = "PNID1";
const GUEST = "34600000001";
const HOUR = 3600_000;

/** Subscriber deliveries: body and headers. */
let forwarded: { body: string; headers: Headers }[] = [];

beforeEach(async () => {
  forwarded = [];
  API_KEY = (await bootstrapAccount()).apiKey;
  await holdAlarms();
});

afterEach(async () => {
  await setLimiter(null);
  vi.restoreAllMocks();
  await reset();
});

type SendAnswer = { status: number; body: unknown };

/** Meta: the template lookup answers with `templateStatus`; each send takes the next answer from `sends`. */
function mockMeta(opts: { templateStatus?: string | null; sends?: SendAnswer[]; onSend?: () => Promise<void> } = {}) {
  const sends = [...(opts.sends ?? [])];
  let wamid = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SUBSCRIBER_URL) {
      forwarded.push({ body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response("ok");
    }
    if (url.includes("/message_templates")) {
      const status = opts.templateStatus === undefined ? "APPROVED" : opts.templateStatus;
      return Response.json({ data: status === null ? [] : [{ name: "promo", language: "es", status, id: "1" }] });
    }
    await opts.onSend?.();
    const answer = sends.shift();
    if (answer) return Response.json(answer.body, { status: answer.status });
    wamid++;
    return Response.json({ contacts: [{ wa_id: GUEST }], messages: [{ id: `wamid.${wamid}` }] });
  });
}

function sendBodies(fetchSpy: ReturnType<typeof mockMeta>) {
  return fetchSpy.mock.calls
    .filter(([input]) => String(input).endsWith("/messages"))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, any>);
}

const sched = (extra: Record<string, unknown> = {}) => ({
  to: GUEST,
  template: {
    name: "promo",
    language: { code: "es" },
    components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }],
  },
  sendAt: Date.now() + HOUR,
  ...extra,
});

function put(key: string, body: unknown, path = `${BASE}/${key}`, apiKey = API_KEY) {
  return exports.default.fetch(path, {
    method: "PUT",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const get = (key: string, apiKey = API_KEY) =>
  exports.default.fetch(`${BASE}/${key}`, { headers: { authorization: `Bearer ${apiKey}` } });
const del = (key: string) =>
  exports.default.fetch(`${BASE}/${key}`, { method: "DELETE", headers: { authorization: `Bearer ${API_KEY}` } });
const list = (query = "") => exports.default.fetch(`${BASE}${query}`, { headers: { authorization: `Bearer ${API_KEY}` } });
const json = async (res: Response) => (await res.json()) as Record<string, any>;

const sql = <T>(fn: (sql: SqlStorage, instance: EccosGateway) => T) =>
  runInDurableObject(gatewayStub(), (instance: EccosGateway) => fn(instance.sql, instance));

const row = (key: string) =>
  sql((s) => s.exec(`SELECT * FROM scheduled_sends WHERE key = ?`, key).toArray()[0] as Record<string, any>);

/** Makes every pending row due and the pacing tick open, then runs one alarm. */
async function due() {
  await sql((s) => {
    s.exec(`UPDATE scheduled_sends SET next_attempt_at = 0, send_at = 0 WHERE status = 'pending'`);
    s.exec(`DELETE FROM ops_state WHERE key = 'scheduled_next_tick_at'`);
  });
  await runAlarm();
}

type Limit = () => Promise<{ success: boolean }>;
const setLimiter = (limit: Limit | null) =>
  runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
    const e = (instance as unknown as { env: Record<string, unknown> }).env;
    if (limit) e.SEND_RATE_LIMITER = { limit };
    else delete e.SEND_RATE_LIMITER;
  });

const FORMATTED = "+34 600 000 001";

/** Inserts `count` pending rows already past their expiry. */
const insertExpired = (count: number) =>
  sql((s) => {
    for (let i = 0; i < count; i++) {
      s.exec(
        `INSERT INTO scheduled_sends (account_id, key, phone_number_id, recipient, template_name, language, components, status,
           send_at, expires_at, next_attempt_at, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'promo', 'es', '[]', 'pending', 1, 2, 1, 0, 1, 1)`,
        "test-account", `bulk-${i}`, PHONE, GUEST,
      );
    }
  });

async function subscribe(secret = false) {
  await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL, ...(secret ? { SUBSCRIBER_SECRET } : {}) });
}

async function forwardedEvents(): Promise<Record<string, any>[]> {
  await runAlarm();
  return forwarded.flatMap((f) => JSON.parse(f.body).events);
}

async function postMetaWebhook(value: Record<string, unknown>) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: TEST_WABA_ID, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE }, ...value } }] }],
  });
  const res = await exports.default.fetch("http://example.com/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
    body,
  });
  expect(res.status).toBe(200);
}

describe("PUT /scheduled/:key", () => {
  it("creates a pending send and sends nothing before it is due", async () => {
    const fetchSpy = mockMeta();
    const sendAt = Date.now() + HOUR;
    const res = await put("appt-1", sched({ sendAt }));
    expect(res.status).toBe(201);
    expect((await json(res)).scheduled).toMatchObject({
      key: "appt-1",
      status: "pending",
      phoneNumberId: PHONE,
      to: GUEST,
      template: { name: "promo", language: "es" },
      sendAt,
      expiresAt: sendAt + HOUR,
      attempts: 0,
      messageId: null,
      failureReason: null,
      error: null,
    });
    expect((await json(await get("appt-1"))).scheduled).toMatchObject({ status: "pending", sendAt });
    expect((await json(await get("appt-1"))).scheduled).not.toHaveProperty("components");
    await runAlarm();
    expect(sendBodies(fetchSpy)).toHaveLength(0);
  });

  it("moves a pending key: one row, the new values are sent", async () => {
    const fetchSpy = mockMeta();
    await put("appt-1", sched());
    const newer = sched({
      sendAt: Date.now() + 2 * HOUR,
      template: { name: "promo", language: "es", components: [{ type: "body", parameters: [{ type: "text", text: "Berta" }] }] },
    });
    await sql((s) => s.exec(`UPDATE scheduled_sends SET attempts = 2, error = '{}'`));
    expect((await put("appt-1", newer)).status).toBe(200);
    expect(await row("appt-1")).toMatchObject({ attempts: 0, error: null });
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM scheduled_sends`).one().n)).toBe(1);
    await due();
    const bodies = sendBodies(fetchSpy);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.template.components[0].parameters[0].text).toBe("Berta");
  });

  it("works on the phone-scoped path too", async () => {
    mockMeta();
    const res = await put("appt-1", sched(), `http://example.com/v1/wabas/${TEST_WABA_ID}/phones/${PHONE}/scheduled/appt-1`);
    expect(res.status).toBe(201);
  });

  it("rejects bad input and other accounts", async () => {
    mockMeta();
    expect((await put("a b", sched())).status).toBe(400);
    expect((await put("k", sched({ sendAt: "2026-11-20T09:00:00" }))).status).toBe(400);
    expect((await put("k", sched({ sendAt: Date.now() + 91 * 24 * HOUR }))).status).toBe(400);
    const sendAt = Date.now() + HOUR;
    expect((await put("k", sched({ sendAt, expiresAt: sendAt }))).status).toBe(400);
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM scheduled_sends`).one().n)).toBe(0);

    await put("mine", sched());
    const other = await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID_OTHER" }]);
    expect((await get("mine", other.apiKey)).status).toBe(404);
  });

  it("checks the template is APPROVED in that language", async () => {
    mockMeta({ templateStatus: "PENDING" });
    const pending = await put("k", sched());
    expect(pending.status).toBe(422);
    expect(await json(pending)).toMatchObject({ error: "template_not_approved", templateStatus: "PENDING" });
    vi.restoreAllMocks();
    mockMeta({ templateStatus: null });
    const missing = await put("k", sched());
    expect(missing.status).toBe(422);
    expect(await json(missing)).toMatchObject({ error: "template_not_found" });
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM scheduled_sends`).one().n)).toBe(0);
  });
});

describe("cancel and conflicts", () => {
  it("DELETE cancels a pending send, drops its values and is idempotent", async () => {
    const fetchSpy = mockMeta();
    await put("appt-1", sched());
    const res = await del("appt-1");
    expect(res.status).toBe(200);
    expect((await json(res)).scheduled.status).toBe("cancelled");
    expect((await row("appt-1")).components).toBeNull();
    await due();
    expect(sendBodies(fetchSpy)).toHaveLength(0);
    const again = await del("appt-1");
    expect(again.status).toBe(200);
    expect((await json(again)).scheduled.status).toBe("cancelled");
    expect((await json(await get("appt-1"))).scheduled.status).toBe("cancelled");
    expect((await del("nope")).status).toBe(404);
  });

  it("answers 409 once it was, or may have been, sent", async () => {
    mockMeta();
    await put("sent", sched());
    await due();
    for (const res of [await put("sent", sched()), await del("sent")]) {
      expect(res.status).toBe(409);
      expect(await json(res)).toEqual({ ok: false, error: "scheduled_send_not_pending", status: "sent" });
    }
    for (const status of ["unknown", "sending"]) {
      await put(status, sched());
      await sql((s) => s.exec(`UPDATE scheduled_sends SET status = ? WHERE key = ?`, status, status));
      expect(await json(await put(status, sched()))).toMatchObject({ error: "scheduled_send_not_pending", status });
      expect((await del(status)).status).toBe(409);
    }
  });

  it("a cancelled or failed key can be scheduled again from scratch", async () => {
    const fetchSpy = mockMeta();
    await put("a", sched());
    await del("a");
    await put("b", sched());
    await sql((s) =>
      s.exec(`UPDATE scheduled_sends SET status = 'failed', reason = 'rejected', attempts = 3, error = '{}' WHERE key = 'b'`),
    );
    for (const key of ["a", "b"]) {
      const res = await put(key, sched());
      expect(res.status).toBe(201);
      expect((await json(res)).scheduled).toMatchObject({ status: "pending", attempts: 0, failureReason: null, error: null });
    }
    await due();
    await due();
    expect(sendBodies(fetchSpy)).toHaveLength(2);
    expect((await row("a")).status).toBe("sent");
  });

  it("limits the pending sends; a move still works", async () => {
    mockMeta();
    await put("k1", sched());
    await sql((s) =>
      s.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
         INSERT OR IGNORE INTO scheduled_sends (account_id, key, phone_number_id, recipient, template_name, language, status,
           send_at, expires_at, next_attempt_at, created_at, updated_at)
         SELECT 'test-account', 'bulk' || i, 'PNID1', '34600000001', 'promo', 'es', 'pending',
           9999999999999, 9999999999999, 9999999999999, 1, 1 FROM n`,
      ),
    );
    const full = await put("new", sched());
    expect(full.status).toBe(409);
    expect(await json(full)).toEqual({ ok: false, error: "too_many_scheduled_sends" });
    expect((await put("k1", sched())).status).toBe(200);
  });
});

describe("sending", () => {
  it("sends a due row and tags the events about it with its scheduleKey", async () => {
    const fetchSpy = mockMeta();
    await subscribe();
    await put("appt-1", sched());
    await due();
    const bodies = sendBodies(fetchSpy);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      to: GUEST,
      type: "template",
      template: { name: "promo", language: { code: "es" }, components: [{ type: "body", parameters: [{ text: "Ana" }] }] },
    });
    expect((await json(await get("appt-1"))).scheduled).toMatchObject({ status: "sent", messageId: "wamid.1", attempts: 1 });
    expect(JSON.parse((await sql((s) => s.exec(`SELECT origin FROM outbound_messages`).one().origin)) as string)).toEqual({
      scheduleKey: "appt-1",
    });

    for (const name of ["sent", "delivered"]) {
      await postMetaWebhook({ statuses: [{ id: "wamid.1", status: name, timestamp: "1700000000", recipient_id: GUEST }] });
    }
    await postMetaWebhook({
      messages: [
        { from: GUEST, id: "wamid.BTN", timestamp: "1700000000", type: "button", button: { text: "Yes", payload: "yes" }, context: { from: "15550555555", id: "wamid.1" } },
      ],
    });
    const events = await forwardedEvents();
    expect(events.map((ev) => ev.type).sort()).toEqual(["delivered", "reply", "sent"]);
    for (const ev of events) expect(ev.scheduleKey).toBe("appt-1");
    expect(events.find((ev) => ev.type === "reply")?.replyTo).toBe("wamid.1");
  });

  it("deletes the values once the send was attempted", async () => {
    mockMeta();
    await put("appt-1", sched());
    expect((await row("appt-1")).components).not.toBeNull();
    await due();
    expect((await row("appt-1")).components).toBeNull();
  });

  it("retries a throttled send, spending an attempt each time", async () => {
    const fetchSpy = mockMeta({ sends: [{ status: 429, body: { error: { code: 130429 } } }] });
    await put("appt-1", sched());
    const before = Date.now();
    await due();
    const first = await row("appt-1");
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    expect(first.next_attempt_at).toBeGreaterThanOrEqual(before + 4_000);
    expect(first.next_attempt_at).toBeLessThan(before + 10_000);
    await due();
    expect(await row("appt-1")).toMatchObject({ status: "sent", attempts: 2 });
    expect(sendBodies(fetchSpy)).toHaveLength(2);
  });

  it("never retries an unknown outcome and tells the subscriber", async () => {
    const fetchSpy = mockMeta({ sends: [{ status: 500, body: {} }] });
    await subscribe();
    await put("appt-1", sched());
    await due();
    expect(await row("appt-1")).toMatchObject({ status: "unknown", reason: "unknown", attempts: 1 });
    await due();
    await runAlarm();
    expect(sendBodies(fetchSpy)).toHaveLength(1);
    const events = (await forwardedEvents()).filter((ev) => ev.type === "scheduled_failed");
    expect(events).toMatchObject([{ scheduleKey: "appt-1", to: GUEST, reason: "unknown" }]);
  });

  it("a send left in flight by a dead run ends unknown", async () => {
    const fetchSpy = mockMeta();
    await subscribe();
    await put("appt-1", sched());
    await sql((s) => s.exec(`UPDATE scheduled_sends SET status = 'sending', updated_at = ?`, Date.now() - 120_000));
    await runAlarm();
    expect(await row("appt-1")).toMatchObject({ status: "unknown", reason: "unknown" });
    expect(sendBodies(fetchSpy)).toHaveLength(0);
    expect((await forwardedEvents()).filter((ev) => ev.type === "scheduled_failed")).toHaveLength(1);
  });

  it("expires a send that was not made in time: no Meta call, a signed scheduled_failed", async () => {
    const fetchSpy = mockMeta();
    await subscribe(true);
    await put("appt-1", sched());
    await sql((s) => s.exec(`UPDATE scheduled_sends SET expires_at = ?`, Date.now() - 1_000));
    await due();
    expect(sendBodies(fetchSpy)).toHaveLength(0);
    expect((await json(await get("appt-1"))).scheduled).toMatchObject({ status: "failed", failureReason: "expired" });
    const events = await forwardedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "scheduled_failed",
      scheduleKey: "appt-1",
      to: GUEST,
      reason: "expired",
      at: expect.any(Number),
      phoneNumberId: PHONE,
    });
    const delivery = forwarded[0]!;
    expect(delivery.headers.get("x-eccos-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(delivery.headers.get("x-webhook-event")).toBe("scheduled_failed");
  });

  it("expiring 150 rows forwards all 150 events and drops their values", async () => {
    mockMeta();
    await subscribe();
    await insertExpired(150);
    await runAlarm();
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM scheduled_sends WHERE status = 'failed' AND components IS NULL`).one().n)).toBe(150);
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM deliveries`).one().n)).toBe(3);
    const events = await forwardedEvents();
    expect(events.filter((ev) => ev.type === "scheduled_failed" && ev.reason === "expired")).toHaveLength(150);
  });

  it("a failing ingest leaves the rows pending for the next tick", async () => {
    mockMeta();
    await subscribe();
    await insertExpired(3);
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      vi.spyOn(instance, "ingest").mockImplementationOnce(() => {
        throw new Error("boom");
      });
    });
    await runAlarm();
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM scheduled_sends WHERE status = 'pending'`).one().n)).toBe(3);
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM inbound_events`).one().n)).toBe(0);
    await runAlarm();
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM scheduled_sends WHERE status = 'failed'`).one().n)).toBe(3);
    expect(await forwardedEvents()).toHaveLength(3);
  });

  it("a failing step waits for its retry instead of spinning on the due rows", async () => {
    mockMeta();
    await subscribe();
    await insertExpired(3);
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      vi.spyOn(instance, "ingest").mockImplementationOnce(() => {
        throw new Error("boom");
      });
    });
    await runAlarm();
    const alarm = await runInDurableObject(gatewayStub(), (_: EccosGateway, state: DurableObjectState) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 20_000);
  });

  it("an expiry passed while the limiter was awaited ends the row with no Meta call", async () => {
    const fetchSpy = mockMeta();
    await subscribe();
    await put("appt-1", sched());
    await setLimiter(async () => {
      await sql((s) => s.exec(`UPDATE scheduled_sends SET expires_at = ?`, Date.now() - 1));
      return { success: true };
    });
    await due();
    expect(sendBodies(fetchSpy)).toHaveLength(0);
    expect(await row("appt-1")).toMatchObject({ status: "failed", reason: "expired", components: null });
    expect((await forwardedEvents()).filter((ev) => ev.type === "scheduled_failed")).toMatchObject([{ scheduleKey: "appt-1", reason: "expired" }]);
  });

  it("a row erased while the limiter was awaited is not sent", async () => {
    const fetchSpy = mockMeta();
    await subscribe();
    await put("appt-1", sched());
    await setLimiter(async () => {
      await sql((s) => s.exec(`DELETE FROM scheduled_sends`));
      return { success: true };
    });
    await due();
    expect(sendBodies(fetchSpy)).toHaveLength(0);
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM outbound_messages`).one().n)).toBe(0);
    expect((await forwardedEvents()).filter((ev) => ev.type === "scheduled_failed")).toHaveLength(0);
  });

  it("waits while the token is missing or unavailable, never past the expiry", async () => {
    const fetchSpy = mockMeta();
    await put("appt-1", sched());
    await put("appt-2", sched());
    const soon = Date.now() + 2_000;
    await sql((s) => s.exec(`UPDATE scheduled_sends SET expires_at = ? WHERE key = 'appt-2'`, soon));
    for (const answer of ["unavailable", "missing"]) {
      await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
        vi.spyOn(instance as unknown as { metaToken: () => Promise<string> }, "metaToken").mockResolvedValueOnce(answer);
      });
      const before = Date.now();
      await due();
      expect(await row("appt-1")).toMatchObject({ status: "pending", attempts: 0 });
      expect((await row("appt-1")).next_attempt_at).toBeGreaterThanOrEqual(before + 30_000);
      expect((await row("appt-2")).next_attempt_at).toBe(soon);
    }
    expect(sendBodies(fetchSpy)).toHaveLength(0);
  });

  it("a refused limiter requeues without sending or spending an attempt, never past the expiry", async () => {
    const fetchSpy = mockMeta();
    await put("appt-1", sched());
    await put("appt-2", sched());
    const soon = Date.now() + 1_000;
    await sql((s) => s.exec(`UPDATE scheduled_sends SET expires_at = ? WHERE key = 'appt-2'`, soon));
    await setLimiter(async () => ({ success: false }));
    const before = Date.now();
    await sql((s) => s.exec(`UPDATE scheduled_sends SET next_attempt_at = 0, send_at = 0`));
    for (let i = 0; i < 2; i++) {
      await sql((s) => s.exec(`DELETE FROM ops_state WHERE key = 'scheduled_next_tick_at'`));
      await runAlarm();
    }
    expect(sendBodies(fetchSpy)).toHaveLength(0);
    expect(await row("appt-1")).toMatchObject({ status: "pending", attempts: 0 });
    expect((await row("appt-1")).next_attempt_at).toBeGreaterThanOrEqual(before + 4_000);
    expect((await row("appt-2")).next_attempt_at).toBe(soon);
  });

  it("gives up on a throttled send at the 8th attempt, and never retries past the expiry", async () => {
    const throttled = { status: 429, body: { error: { code: 130429 } } };
    mockMeta({ sends: [throttled, throttled] });
    await subscribe();
    await put("last", sched());
    await put("soon", sched());
    const soon = Date.now() + 2_000;
    await sql((s) => {
      s.exec(`UPDATE scheduled_sends SET attempts = 7 WHERE key = 'last'`);
      s.exec(`UPDATE scheduled_sends SET expires_at = ? WHERE key = 'soon'`, soon);
    });
    await sql((s) => s.exec(`UPDATE scheduled_sends SET next_attempt_at = CASE key WHEN 'last' THEN 1 ELSE 2 END, send_at = 0`));
    for (let i = 0; i < 2; i++) {
      await sql((s) => s.exec(`DELETE FROM ops_state WHERE key = 'scheduled_next_tick_at'`));
      await runAlarm();
    }
    expect(await row("last")).toMatchObject({ status: "failed", reason: "rejected", attempts: 8 });
    expect(await row("soon")).toMatchObject({ status: "pending", attempts: 1, next_attempt_at: soon });
    expect((await forwardedEvents()).filter((ev) => ev.type === "scheduled_failed")).toMatchObject([{ scheduleKey: "last", reason: "rejected" }]);
  });

  it("a rejected send fails that row alone, with Meta's error, even for halt-class codes", async () => {
    const fetchSpy = mockMeta({
      sends: [
        { status: 400, body: { error: { code: 131026, message: "generic", error_data: { details: "Message undeliverable" } } } },
        { status: 400, body: { error: { code: 132001, message: "template missing" } } },
      ],
    });
    await subscribe();
    for (const key of ["a", "b", "c"]) await put(key, sched({ sendAt: Date.now() + HOUR }));
    await sql((s) => s.exec(`UPDATE scheduled_sends SET send_at = 0, next_attempt_at = CASE key WHEN 'a' THEN 1 WHEN 'b' THEN 2 ELSE 3 END`));
    for (let i = 0; i < 3; i++) {
      await sql((s) => s.exec(`DELETE FROM ops_state WHERE key = 'scheduled_next_tick_at'`));
      await runAlarm();
    }
    expect(await row("a")).toMatchObject({ status: "failed", reason: "rejected" });
    expect(await row("b")).toMatchObject({ status: "failed", reason: "rejected" });
    expect(await row("c")).toMatchObject({ status: "sent" });
    expect(sendBodies(fetchSpy)).toHaveLength(3);
    const events = (await forwardedEvents()).filter((ev) => ev.type === "scheduled_failed");
    expect(events).toMatchObject([
      { scheduleKey: "a", reason: "rejected", errorCode: "131026", errorMessage: "Message undeliverable" },
      { scheduleKey: "b", reason: "rejected", errorCode: "132001", errorMessage: "template missing" },
    ]);
  });
});

describe("pacing and alarm", () => {
  it("a due scheduled send goes ahead of a running broadcast within the tick", async () => {
    const fetchSpy = mockMeta();
    const res = await exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/broadcasts`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        template: { name: "promo", language: { code: "es" } },
        recipients: ["34600000002", "34600000003", "34600000004"].map((to) => ({ to })),
      }),
    });
    expect(res.status).toBe(202);
    await put("appt-1", sched());
    await sql((s) => s.exec(`UPDATE scheduled_sends SET next_attempt_at = 0, send_at = 0`));
    await runAlarm();
    expect(sendBodies(fetchSpy).map((b) => b.to)).toEqual([GUEST]);
    await sql((s) => s.exec(`UPDATE broadcasts SET next_send_at = 0`));
    await runAlarm();
    expect(sendBodies(fetchSpy).map((b) => b.to)).toEqual([GUEST, "34600000002"]);
  });

  it("arms one alarm at the send time, not per-second wakes", async () => {
    mockMeta();
    const sendAt = Date.now() + 30 * 24 * HOUR;
    await put("far", sched({ sendAt }));
    await runAlarm();
    expect(await runInDurableObject(gatewayStub(), (_i, state) => state.storage.getAlarm())).toBe(sendAt);

    const broadcast = await exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/broadcasts`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        template: { name: "promo", language: { code: "es" } },
        recipients: [{ to: "34600000002" }, { to: "34600000003" }],
      }),
    });
    expect(broadcast.status).toBe(202);
    const alarm = () => runInDurableObject(gatewayStub(), (_i, state) => state.storage.getAlarm());
    await sql((s) => s.exec(`UPDATE broadcasts SET next_send_at = 0`));
    await runAlarm();
    expect(await alarm()).toBeLessThan(Date.now() + 5_000);
    await sql((s) => s.exec(`UPDATE broadcasts SET next_send_at = 0`));
    await runAlarm();
    expect(await alarm()).toBe(sendAt);
  });

  it("a send scheduled during the alarm's awaits is not overwritten by its final re-arm", async () => {
    const sendAt = Date.now() + 20_000;
    let issued = false;
    mockMeta({
      onSend: async () => {
        if (issued) return;
        issued = true;
        expect((await put("late", sched({ sendAt }))).status).toBe(201);
      },
    });
    // No subscriber: the events wait in `deliveries`, whose hold wake is about an hour away.
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.ingest([{ type: "sent", transportMessageId: "wamid.X", at: 1 }]));
    const res = await exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/broadcasts`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ template: { name: "promo", language: { code: "es" } }, recipients: [{ to: "34600000002" }] }),
    });
    expect(res.status).toBe(202);
    await runAlarm();
    expect(issued).toBe(true);
    const alarm = await runInDurableObject(gatewayStub(), (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm).toBeLessThanOrEqual(sendAt);
  });

  it("a PUT arms the alarm", async () => {
    mockMeta();
    // The pool fires (and clears) an alarm armed for now, so the call is observed instead.
    const armed: number[] = [];
    await runInDurableObject(gatewayStub(), (_i, state) => {
      const original = state.storage.setAlarm.bind(state.storage);
      vi.spyOn(state.storage, "setAlarm").mockImplementation((at) => {
        armed.push(Number(at));
        return original(at);
      });
    });
    const before = Date.now();
    await put("now", sched({ sendAt: before }));
    expect(armed).toHaveLength(1);
    expect(armed[0]).toBeLessThanOrEqual(Date.now());
    const sendAt = Date.now() + HOUR;
    await put("later", sched({ sendAt }));
    expect(armed.at(-1)).toBe(sendAt);
  });
});

describe("docs contract", () => {
  it("the documented scheduled_failed example has the keys of the emitted event", async () => {
    mockMeta({ sends: [{ status: 400, body: { error: { code: 131026, message: "Message undeliverable" } } }] });
    await subscribe();
    await put("appt-8812", sched());
    await due();
    const emitted = (await forwardedEvents()).find((ev) => ev.type === "scheduled_failed")!;
    const documented = jsonFences(eventsMd).find((ev) => ev.type === "scheduled_failed")!;
    expect(Object.keys(emitted).sort()).toEqual(Object.keys(documented).sort());
  });
});

describe("privacy and retention", () => {
  it("erasing a customer removes their scheduled sends, pending ones are never sent", async () => {
    const fetchSpy = mockMeta();
    await subscribe();
    await put("sent", sched());
    await due();
    await put("pending", sched());
    await put("expired", sched());
    await sql((s) => s.exec(`UPDATE scheduled_sends SET expires_at = 1, next_attempt_at = 0 WHERE key = 'expired'`));
    await runAlarm();
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM inbound_events WHERE type = 'scheduled_failed'`).one().n)).toBe(1);

    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => instance.eraseByPhone(GUEST));
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM scheduled_sends`).one().n)).toBe(0);
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM inbound_events WHERE type = 'scheduled_failed'`).one().n)).toBe(0);
    expect(await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM deliveries WHERE payload LIKE '%scheduled_failed%'`).one().n)).toBe(0);
    await due();
    expect(sendBodies(fetchSpy)).toHaveLength(1);
  });

  it("erases a scheduled send written with a formatted number, and its failure event", async () => {
    mockMeta();
    await subscribe();
    await put("sent", sched({ to: FORMATTED }));
    await due();
    await put("expired", sched({ to: FORMATTED }));
    await sql((s) => s.exec(`UPDATE scheduled_sends SET expires_at = 1, next_attempt_at = 0 WHERE key = 'expired'`));
    await runAlarm();
    expect(await sql((s) => s.exec(`SELECT payload FROM inbound_events WHERE type = 'scheduled_failed'`).one().payload)).toContain(`"to":"${GUEST}"`);

    const result = await runInDurableObject(gatewayStub(), (instance: EccosGateway) => instance.eraseByPhone(GUEST));
    expect(result.ok).toBe(true);
    for (const [table, column] of [
      ["scheduled_sends", "recipient"],
      ["inbound_events", "payload"],
      ["deliveries", "payload"],
      ["outbound_messages", "recipient"],
      ["messages", "wa_id"],
    ]) {
      const n = await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE '%600%'`).one().n);
      expect([table, n]).toEqual([table, 0]);
    }
  });

  it("settled rows leave with the content window; a pending one stays", async () => {
    mockMeta();
    await put("sent", sched());
    await due();
    await put("pending", sched());
    await sql((s, instance) => {
      s.exec(`UPDATE scheduled_sends SET created_at = 1 WHERE key = 'pending'`);
      instance.pruneExpired(Date.now() + 31 * 86_400_000, 30, 90);
      expect(s.exec(`SELECT key FROM scheduled_sends`).toArray().map((r) => r.key)).toEqual(["pending"]);
    });
  });
});

describe("GET /scheduled", () => {
  it("lists by key with a cursor and a status filter", async () => {
    mockMeta();
    for (const key of ["a", "b", "c"]) await put(key, sched());
    await del("b");
    const first = await json(await list("?limit=2"));
    expect(first.scheduled.map((r: any) => r.key)).toEqual(["a", "b"]);
    expect(first.next).toBe("b");
    const second = await json(await list(`?limit=2&after=${first.next}`));
    expect(second.scheduled.map((r: any) => r.key)).toEqual(["c"]);
    expect(second.next).toBeUndefined();
    const cancelled = await json(await list("?status=cancelled"));
    expect(cancelled.scheduled.map((r: any) => r.key)).toEqual(["b"]);
    expect((await list("?status=nope")).status).toBe(400);
  });
});
