import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, gatewayStub, holdAlarms, runAlarm, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

let API_KEY = "";
const BASE = `http://example.com/v1/wabas/${TEST_WABA_ID}/broadcasts`;

beforeEach(async () => {
  API_KEY = (await bootstrapAccount()).apiKey;
  await holdAlarms();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

type SendAnswer = { status: number; body: unknown };

/**
 * Meta: the template lookup answers with `templateStatus`, and each send takes
 * the next answer from `sends` (default: accepted with a fresh wamid).
 */
function mockMeta(opts: { templateStatus?: string | null; sends?: SendAnswer[] } = {}) {
  const sends = [...(opts.sends ?? [])];
  let wamid = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/message_templates")) {
      const status = opts.templateStatus === undefined ? "APPROVED" : opts.templateStatus;
      const data = status === null ? [] : [{ name: "promo", language: "es", status, id: "1" }];
      return Response.json({ data });
    }
    const answer = sends.shift();
    if (answer) return Response.json(answer.body, { status: answer.status });
    wamid++;
    return Response.json({ contacts: [{ wa_id: "34600000000" }], messages: [{ id: `wamid.${wamid}` }] });
  });
}

function sendBodies(fetchSpy: ReturnType<typeof mockMeta>) {
  return fetchSpy.mock.calls
    .filter(([input]) => String(input).endsWith("/messages"))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

function create(body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(BASE, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path = "") {
  return exports.default.fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${API_KEY}` } });
}

const broadcast = (to: string[], extra: Record<string, unknown> = {}) => ({
  template: { name: "promo", language: { code: "es" } },
  recipients: to.map((number) => ({
    to: number,
    components: [{ type: "body", parameters: [{ type: "text", text: `name-${number}` }] }],
  })),
  ...extra,
});

/** Makes every running broadcast due, then runs one alarm: one paced tick. */
async function tick() {
  await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
    instance.sql.exec(`UPDATE broadcasts SET next_send_at = 0 WHERE status = 'running'`);
  });
  await runAlarm();
}

async function createdId(body: unknown): Promise<string> {
  const res = await create(body);
  expect(res.status).toBe(202);
  return ((await res.json()) as { broadcast: { id: string } }).broadcast.id;
}

async function summary(id: string) {
  return ((await (await get(`/${id}`)).json()) as { broadcast: Record<string, unknown> }).broadcast;
}

describe("POST /broadcasts", () => {
  it("queues the recipients and reports the broadcast", async () => {
    mockMeta();
    const res = await create(broadcast(["34600000001", "34600000002", "+34 600 000 001"]));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { broadcast: Record<string, unknown> };
    expect(body.broadcast).toMatchObject({
      status: "running",
      total: 2,
      duplicatesSkipped: 1,
      ratePerMinute: 60,
      template: { name: "promo", language: "es" },
      counts: { queued: 2, sent: 0 },
    });
  });

  it("refuses the whole request when any recipient is invalid, naming it", async () => {
    mockMeta();
    const res = await create(broadcast(["34600000001", "not-a-phone"]));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ invalid: [{ index: 1 }] });
  });

  it("refuses a template that is not approved, or not there, before queueing anything", async () => {
    mockMeta({ templateStatus: "PENDING" });
    expect((await create(broadcast(["34600000001"]))).status).toBe(422);
    vi.restoreAllMocks();
    mockMeta({ templateStatus: null });
    const missing = await create(broadcast(["34600000001"]));
    expect(await missing.json()).toMatchObject({ error: "template_not_found" });
    expect(((await (await get()).json()) as { broadcasts: unknown[] }).broadcasts).toEqual([]);
  });

  it("an Idempotency-Key replays the broadcast, and refuses a different body", async () => {
    mockMeta();
    const first = await create(broadcast(["34600000001"]), { "idempotency-key": "campaign-1" });
    const again = await create(broadcast(["34600000001"]), { "idempotency-key": "campaign-1" });
    const firstId = ((await first.json()) as { broadcast: { id: string } }).broadcast.id;
    expect(((await again.json()) as { broadcast: { id: string } }).broadcast.id).toBe(firstId);
    const other = await create(broadcast(["34600000002"]), { "idempotency-key": "campaign-1" });
    expect(other.status).toBe(422);
  });

  it("needs an API key", async () => {
    const res = await exports.default.fetch(BASE, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});

describe("sending", () => {
  it("sends one template per recipient with its own values, paced per tick, and logs each send", async () => {
    const fetchSpy = mockMeta();
    const id = await createdId(broadcast(["34600000001", "34600000002"]));
    await tick();
    expect(sendBodies(fetchSpy)).toHaveLength(1);
    await tick();
    const bodies = sendBodies(fetchSpy);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      messaging_product: "whatsapp",
      to: "34600000002",
      type: "template",
      template: {
        name: "promo",
        language: { code: "es" },
        components: [{ type: "body", parameters: [{ type: "text", text: "name-34600000002" }] }],
      },
    });
    await tick();
    expect(await summary(id)).toMatchObject({ status: "completed", counts: { sent: 2, queued: 0 } });

    const outbound = await new GatewayRPC(createExecutionContext(), env).listOutbound(
      { wabaId: TEST_WABA_ID },
      TEST_ACCOUNT_ID,
    );
    expect(outbound.map((row) => row.transport_message_id).sort()).toEqual(["wamid.1", "wamid.2"]);
  });

  it("keeps no message values once a recipient is settled", async () => {
    mockMeta();
    await createdId(broadcast(["34600000001"]));
    await tick();
    const components = await runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
      instance.sql.exec(`SELECT components FROM broadcast_recipients`).toArray()[0]?.components,
    );
    expect(components).toBeNull();
  });

  it("queues a throttled recipient again and backs off; it is sent on a later tick", async () => {
    const fetchSpy = mockMeta({ sends: [{ status: 400, body: { error: { code: 130429, message: "Rate limit hit" } } }] });
    const id = await createdId(broadcast(["34600000001"]));
    await tick();
    expect(await summary(id)).toMatchObject({ status: "running", counts: { queued: 1 } });
    const nextSendAt = await runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
      Number(instance.sql.exec(`SELECT next_send_at FROM broadcasts`).toArray()[0]?.next_send_at),
    );
    expect(nextSendAt).toBeGreaterThan(Date.now() + 3_000);
    await tick();
    expect(sendBodies(fetchSpy)).toHaveLength(2);
    expect(await summary(id)).toMatchObject({ status: "completed", counts: { sent: 1 } });
  });

  it("never retries an unknown outcome", async () => {
    const fetchSpy = mockMeta({ sends: [{ status: 503, body: { error: { code: 1 } } }] });
    const id = await createdId(broadcast(["34600000001"]));
    await tick();
    await tick();
    expect(sendBodies(fetchSpy)).toHaveLength(1);
    expect(await summary(id)).toMatchObject({ status: "completed", counts: { unknown: 1 } });
  });

  it("a recipient's own failure does not stop the others", async () => {
    mockMeta({ sends: [{ status: 400, body: { error: { code: 131026, message: "Message undeliverable" } } }] });
    const id = await createdId(broadcast(["34600000001", "34600000002"]));
    await tick();
    await tick();
    await tick();
    expect(await summary(id)).toMatchObject({ status: "completed", counts: { failed: 1, sent: 1 } });
    const failed = (await (await get(`/${id}/recipients?status=failed`)).json()) as {
      recipients: { to: string; error: { error: { code: number } } }[];
    };
    expect(failed.recipients).toMatchObject([{ to: "34600000001", error: { error: { code: 131026 } } }]);
  });

  it("halts on an error every recipient would hit, cancelling the rest", async () => {
    const fetchSpy = mockMeta({ sends: [{ status: 400, body: { error: { code: 132001, message: "Template does not exist" } } }] });
    const id = await createdId(broadcast(["34600000001", "34600000002", "34600000003"]));
    await tick();
    await tick();
    expect(sendBodies(fetchSpy)).toHaveLength(1);
    expect(await summary(id)).toMatchObject({
      status: "halted",
      counts: { failed: 1, cancelled: 2 },
      haltReason: "Meta refused the send with error 132001",
    });
  });

  it("a send left mid-flight by a dead run ends as unknown, never sent again", async () => {
    const fetchSpy = mockMeta();
    const id = await createdId(broadcast(["34600000001"]));
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.sql.exec(`UPDATE broadcast_recipients SET status = 'sending', updated_at = ?`, Date.now() - 120_000);
    });
    await tick();
    expect(sendBodies(fetchSpy)).toHaveLength(0);
    expect(await summary(id)).toMatchObject({ status: "completed", counts: { unknown: 1 } });
  });
});

describe("reading and cancelling", () => {
  it("cancel stops the recipients not yet sent", async () => {
    const fetchSpy = mockMeta();
    const id = await createdId(broadcast(["34600000001", "34600000002"]));
    await tick();
    const res = await exports.default.fetch(`${BASE}/${id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(((await res.json()) as { broadcast: Record<string, unknown> }).broadcast).toMatchObject({
      status: "cancelled",
      counts: { sent: 1, cancelled: 1 },
    });
    await tick();
    expect(sendBodies(fetchSpy)).toHaveLength(1);
  });

  it("delivery receipts are counted against the broadcast's messages", async () => {
    mockMeta();
    const id = await createdId(broadcast(["34600000001"]));
    await tick();
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.sql.exec(
        `INSERT INTO inbound_events (type, transport_message_id, payload, received_at) VALUES ('delivered', 'wamid.1', '{}', ?)`,
        Date.now(),
      );
    });
    expect(await summary(id)).toMatchObject({ delivery: { delivered: 1, read: 0, failed: 0 } });
  });

  it("recipients page with a cursor", async () => {
    mockMeta();
    const id = await createdId(broadcast(["34600000001", "34600000002", "34600000003"]));
    const first = (await (await get(`/${id}/recipients?limit=2`)).json()) as { recipients: { seq: number }[]; next: number };
    expect(first.recipients.map((row) => row.seq)).toEqual([0, 1]);
    const second = (await (await get(`/${id}/recipients?limit=2&after=${first.next}`)).json()) as {
      recipients: { seq: number }[];
      next?: number;
    };
    expect(second.recipients.map((row) => row.seq)).toEqual([2]);
    expect(second.next).toBeUndefined();
  });

  it("another account's broadcast is not found", async () => {
    mockMeta();
    const id = await createdId(broadcast(["34600000001"]));
    const other = await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID_OTHER" }]);
    const res = await exports.default.fetch(`${BASE}/${id}`, { headers: { authorization: `Bearer ${other.apiKey}` } });
    expect(res.status).toBe(404);
  });
});

describe("privacy", () => {
  it("erasing a customer removes them from broadcasts", async () => {
    mockMeta();
    await createdId(broadcast(["34600000001", "34600000002"]));
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      await instance.eraseByPhone("34600000001");
    });
    const left = await runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
      instance.sql.exec(`SELECT recipient FROM broadcast_recipients`).toArray().map((row) => row.recipient),
    );
    expect(left).toEqual(["34600000002"]);
  });

  it("finished broadcasts leave with the content window", async () => {
    mockMeta();
    await createdId(broadcast(["34600000001"]));
    await tick();
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.pruneExpired(Date.now() + 31 * 86_400_000, 30, 90);
      expect(instance.sql.exec(`SELECT COUNT(*) AS n FROM broadcast_recipients`).toArray()[0]?.n).toBe(0);
      expect(instance.sql.exec(`SELECT COUNT(*) AS n FROM broadcasts`).toArray()[0]?.n).toBe(0);
    });
  });
});

describe("review cases", () => {
  const setSql = (query: string, ...params: unknown[]) =>
    runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.sql.exec(query, ...(params as SqlStorageValue[]));
    });

  it("a recipient whose own values Meta refuses fails alone; the broadcast goes on", async () => {
    mockMeta({ sends: [{ status: 400, body: { error: { code: 132000, message: "Number of parameters does not match" } } }] });
    const id = await createdId(broadcast(["34600000001", "34600000002"]));
    await tick();
    await tick();
    await tick();
    expect(await summary(id)).toMatchObject({ status: "completed", counts: { failed: 1, sent: 1 } });
  });

  it("the same parameter error on the template's own values halts", async () => {
    mockMeta({ sends: [{ status: 400, body: { error: { code: 132000 } } }] });
    const id = await createdId({
      template: { name: "promo", language: "es", components: [{ type: "body", parameters: [] }] },
      recipients: [{ to: "34600000001" }, { to: "34600000002" }],
    });
    await tick();
    expect(await summary(id)).toMatchObject({ status: "halted", counts: { failed: 1, cancelled: 1 } });
  });

  it("stops when the first sends all fail, whatever the code", async () => {
    mockMeta({ sends: Array.from({ length: 25 }, () => ({ status: 400, body: { error: { code: 131026 } } })) });
    const numbers = Array.from({ length: 25 }, (_, i) => `346000001${String(i).padStart(2, "0")}`);
    const id = await createdId(broadcast(numbers));
    await setSql(`UPDATE broadcasts SET rate_per_minute = 300`);
    for (let i = 0; i < 6; i++) await tick();
    expect(await summary(id)).toMatchObject({
      status: "halted",
      haltReason: "the first 20 sends all failed",
      counts: { failed: 20, cancelled: 5 },
    });
  });

  it("a throttled recipient gives up as failed after the last attempt", async () => {
    mockMeta({ sends: [{ status: 400, body: { error: { code: 130429 } } }] });
    const id = await createdId(broadcast(["34600000001"]));
    await setSql(`UPDATE broadcast_recipients SET attempts = 7`);
    await tick();
    expect(await summary(id)).toMatchObject({ status: "completed", counts: { failed: 1 } });
  });

  it("the limiter refusing a send queues it again without spending an attempt", async () => {
    const fetchSpy = mockMeta();
    const id = await createdId(broadcast(["34600000001"]));
    const refused = { limit: async () => ({ success: false }) };
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      (instance as unknown as { env: Record<string, unknown> }).env.SEND_RATE_LIMITER = refused;
    });
    await tick();
    expect(sendBodies(fetchSpy)).toHaveLength(0);
    const row = await runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
      instance.sql.exec(`SELECT status, attempts FROM broadcast_recipients`).toArray()[0],
    );
    expect(row).toEqual({ status: "queued", attempts: 0 });
    expect(await summary(id)).toMatchObject({ status: "running" });
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      delete (instance as unknown as { env: Record<string, unknown> }).env.SEND_RATE_LIMITER;
    });
  });

  it("a WABA that is no longer connected halts the broadcast; a failed lookup waits", async () => {
    mockMeta();
    const id = await createdId(broadcast(["34600000001"]));
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      vi.spyOn(instance as unknown as { metaToken: () => Promise<string> }, "metaToken").mockResolvedValueOnce("unavailable");
    });
    await tick();
    expect(await summary(id)).toMatchObject({ status: "running", counts: { queued: 1 } });
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      vi.spyOn(instance as unknown as { metaToken: () => Promise<string> }, "metaToken").mockResolvedValueOnce("missing");
    });
    await tick();
    expect(await summary(id)).toMatchObject({ status: "halted", counts: { cancelled: 1 } });
  });

  it("a failing broadcast step never takes the rest of the alarm down", async () => {
    mockMeta();
    await createdId(broadcast(["34600000001"]));
    const alarmAt = await runInDurableObject(gatewayStub(), async (instance: EccosGateway, state: DurableObjectState) => {
      vi.spyOn(instance as unknown as { broadcastStep: () => Promise<number> }, "broadcastStep").mockRejectedValue(new Error("boom"));
      instance.sql.exec(`UPDATE broadcasts SET next_send_at = 0`);
      await state.storage.deleteAlarm();
      await Object.getPrototypeOf(instance).alarm.call(instance);
      return state.storage.getAlarm();
    });
    expect(alarmAt).toBeGreaterThan(Date.now() + 20_000);
  });

  it("two broadcasts progress together, and a sixth running one is refused", async () => {
    const fetchSpy = mockMeta();
    const a = await createdId(broadcast(["34600000001"]));
    const b = await createdId(broadcast(["34600000002"]));
    await tick();
    expect(sendBodies(fetchSpy)).toHaveLength(2);
    expect(await summary(a)).toMatchObject({ counts: { sent: 1 } });
    expect(await summary(b)).toMatchObject({ counts: { sent: 1 } });
    for (let i = 0; i < 5; i++) await createdId(broadcast([`3460000003${i}`]));
    expect((await create(broadcast(["34600000040"]))).status).toBe(409);
  });

  it("a retry with the same key gets its broadcast back without asking Meta again", async () => {
    const fetchSpy = mockMeta();
    const first = await create(broadcast(["34600000001"]), { "idempotency-key": "k" });
    const id = ((await first.json()) as { broadcast: { id: string } }).broadcast.id;
    const lookups = () => fetchSpy.mock.calls.filter(([input]) => String(input).includes("/message_templates")).length;
    expect(lookups()).toBe(1);
    const again = await create(broadcast(["34600000001"]), { "idempotency-key": "k" });
    expect(((await again.json()) as { broadcast: { id: string } }).broadcast.id).toBe(id);
    expect(lookups()).toBe(1);
  });
});
