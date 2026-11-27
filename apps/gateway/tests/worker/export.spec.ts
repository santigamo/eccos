/**
 * GET /v1/wabas/:wabaId/export: streamed in short Durable Object reads, with the same body
 * `exportData()` produced, and a per-WABA cooldown the console's RPC export does not have.
 */
import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { EXPORT_PAGE_ROWS, EXPORT_SECTIONS } from "../../src/export-pages";
import { claimExport, exportCooldownMs, exportDay } from "../../src/export-usage";
import { GatewayRPC } from "../../src/rpc";
import worker from "../../src/worker";
import { bootstrapAccount, gatewayStub, holdAlarms, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

const OTHER_WABA = "WABA_EXPORT_OTHER";
let apiKey = "";

beforeEach(async () => {
  apiKey = (await bootstrapAccount()).apiKey;
  await bootstrapAccount(TEST_ACCOUNT_ID, OTHER_WABA, [{ phoneNumberId: "PN_OTHER" }]);
  await holdAlarms();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const exportRequest = (wabaId = TEST_WABA_ID) =>
  new Request(`http://example.com/v1/wabas/${wabaId}/export`, { headers: { authorization: `Bearer ${apiKey}` } });

const exportCall = (wabaId?: string) => exports.default.fetch(exportRequest(wabaId));

const exportWith = (vars: Partial<Env>) => worker.fetch(exportRequest(), { ...env, ...vars }, createExecutionContext());

/** The status of a response whose body was read to the end. */
async function statusOf(res: Response | Promise<Response>): Promise<number> {
  const done = await res;
  await done.arrayBuffer();
  return done.status;
}

/** Moves this WABA's last granted export `ms` into the past. */
async function ageLastExport(ms: number) {
  await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
    const row = i.sql.exec("SELECT value FROM ops_state WHERE key = 'export_usage'").one();
    const usage = JSON.parse(row.value as string) as { lastAt: number };
    usage.lastAt -= ms;
    i.sql.exec("UPDATE ops_state SET value = ? WHERE key = 'export_usage'", JSON.stringify(usage));
  });
}

/** More rows than one page in every section; messages share `at` across page edges, deliveries outgrow the size budget. */
async function seedBeyondOnePage(n = 2 * EXPORT_PAGE_ROWS + 7) {
  await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
    i.saveConfig({ DISPLAY_PHONE_NUMBER: "+34600000000", META_ACCESS_TOKEN: "secret-token" });
    const big = "x".repeat(5_000);
    for (let k = 0; k < n; k++) {
      const wa = `3460${String(k).padStart(7, "0")}`;
      i.sql.exec(
        `INSERT INTO inbound_events (type, transport_message_id, message_id, phone_number_id, payload, received_at, delivery_id)
         VALUES ('reply', NULL, ?, 'PNID1', ?, ?, ?)`,
        `wamid.in.${k}`,
        JSON.stringify({ type: "reply", n: k }),
        1_700_000_000_000 + k,
        k % 3 === 0 ? null : k,
      );
      i.sql.exec(
        `INSERT INTO outbound_messages (transport_message_id, recipient, phone_number_id, request, status, error, created_at)
         VALUES (?, ?, 'PNID1', '{}', 'sent', NULL, ?)`,
        `wamid.out.${k}`,
        wa,
        1_700_000_000_000 + k,
      );
      i.sql.exec(
        `INSERT INTO deliveries (phone_number_id, payload, status, attempts, next_attempt_at, created_at, finished_at)
         VALUES ('PNID1', ?, 'delivered', 1, 0, ?, ?)`,
        JSON.stringify({ events: [big], n: k }),
        1_700_000_000_000 + k,
        1_700_000_000_500 + k,
      );
      i.sql.exec(
        `INSERT INTO messages (id, wa_id, direction, origin, type, text, content, at, status, error, target_id, phone_number_id, created_at)
         VALUES (?, ?, 'in', 'live', 'text', ?, NULL, ?, NULL, NULL, NULL, 'PNID1', ?)`,
        `wamid.msg.${k}`,
        wa,
        `hello ${k}`,
        1_700_000_000_000 + Math.floor(k / 7),
        1_700_000_000_000,
      );
      i.sql.exec("INSERT INTO contacts (wa_id, name, source, updated_at) VALUES (?, ?, 'webhook', ?)", wa, `Name ${k}`, k);
      i.sql.exec(
        "INSERT INTO held_webhooks (phone_number_id, events, event_count, held_at) VALUES ('PNID1', '[]', 1, ?)",
        1_700_000_000_000 + k,
      );
      i.sql.exec("INSERT INTO customer_ids (user_id, wa_id) VALUES (?, ?)", `US.${n - k}`, wa);
    }
  });
}

describe("streamed export", () => {
  it("writes exactly the body exportData() gave, in many short reads", async () => {
    await seedBeyondOnePage();
    const reference = await getGatewayStubForWaba(env, TEST_WABA_ID).exportData();
    const pages = vi.spyOn(EccosGateway.prototype, "exportPage");
    const log = vi.spyOn(console, "log");

    const res = await exportCall();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const text = await res.text();

    expect(text).toBe(JSON.stringify({ ok: true, data: reference }));
    expect(Object.keys(JSON.parse(text).data)).toEqual([...EXPORT_SECTIONS, "config"]);
    expect(reference.config).not.toHaveProperty("META_ACCESS_TOKEN");
    for (const section of EXPORT_SECTIONS) {
      expect(reference[section].length, section).toBeGreaterThan(2 * EXPORT_PAGE_ROWS);
      const reads = pages.mock.calls.filter(([s]) => s === section);
      expect(reads.length, section).toBeGreaterThanOrEqual(3);
    }
    // A 5 KB payload per delivery: the size budget, not the row cap, ends those pages.
    const deliveryPages = pages.mock.results
      .filter((_, k) => pages.mock.calls[k]![0] === "deliveries")
      .map((r) => (r.value as { rows: unknown[] }).rows.length);
    expect(Math.max(...deliveryPages)).toBeLessThan(EXPORT_PAGE_ROWS);

    const line = log.mock.calls.map(([l]) => JSON.parse(String(l))).find((l) => l.event === "export");
    expect(line).toMatchObject({
      status: 200,
      wabaId: TEST_WABA_ID,
      inbound: reference.inbound.length,
      outbound: reference.outbound.length,
      deliveries: reference.deliveries.length,
    });
  });

  it("writes the same body for an empty WABA", async () => {
    const reference = await getGatewayStubForWaba(env, TEST_WABA_ID).exportData();
    expect(await (await exportCall()).text()).toBe(JSON.stringify({ ok: true, data: reference }));
  });

  it("errors the body and logs a 500 when a read fails mid-stream", async () => {
    await seedBeyondOnePage(EXPORT_PAGE_ROWS + 1);
    const real = EccosGateway.prototype.exportPage;
    let calls = 0;
    vi.spyOn(EccosGateway.prototype, "exportPage").mockImplementation(function (this: EccosGateway, ...args) {
      if (++calls === 2) throw new Error("read failed");
      return real.apply(this, args);
    });
    const log = vi.spyOn(console, "log");
    const res = await exportCall();
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
    const line = log.mock.calls.map(([l]) => JSON.parse(String(l))).find((l) => l.event === "export");
    expect(line).toMatchObject({ status: 500, wabaId: TEST_WABA_ID, end: "failed", inbound: EXPORT_PAGE_ROWS });
  });
});

describe("export cooldown", () => {
  it("refuses a second export with 429 and the seconds left, until the cooldown passes", async () => {
    const log = vi.spyOn(console, "log");
    expect(await statusOf(exportCall())).toBe(200);

    const refused = await exportCall();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("900");
    expect(await refused.json()).toEqual({ ok: false, error: "export rate limited", retryAfter: 900 });
    const lines = log.mock.calls.map(([l]) => JSON.parse(String(l))).filter((l) => l.event === "export");
    expect(lines.at(-1)).toMatchObject({ status: 429, level: "warn", wabaId: TEST_WABA_ID, retryAfter: 900 });

    await ageLastExport(600_000);
    const later = await exportCall();
    expect(later.status).toBe(429);
    expect(later.headers.get("retry-after")).toBe("300");

    await ageLastExport(300_000);
    expect(await statusOf(exportCall())).toBe(200);
    expect(await statusOf(exportCall())).toBe(429);
  });

  it("is per WABA", async () => {
    expect(await statusOf(exportCall())).toBe(200);
    expect(await statusOf(exportCall())).toBe(429);
    expect(await statusOf(exportCall(OTHER_WABA))).toBe(200);
  });

  it("lets only one of two concurrent exports through", async () => {
    const statuses = await Promise.all([statusOf(exportCall()), statusOf(exportCall())]);
    expect(statuses.sort()).toEqual([200, 429]);
  });

  it("does not apply to the console's RPC export, and that export does not start it", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    await rpc.exportData(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(await statusOf(exportCall())).toBe(200);
    await rpc.exportData(TEST_WABA_ID, TEST_ACCOUNT_ID);
    await expect(rpc.exportData(TEST_WABA_ID, TEST_ACCOUNT_ID)).resolves.toHaveProperty("config");
  });

  it("follows EXPORT_COOLDOWN_SECONDS, and 0 turns it off", async () => {
    expect(await statusOf(exportWith({ EXPORT_COOLDOWN_SECONDS: "0" }))).toBe(200);
    expect(await statusOf(exportWith({ EXPORT_COOLDOWN_SECONDS: "0" }))).toBe(200);
    const refused = await exportWith({ EXPORT_COOLDOWN_SECONDS: "60" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
  });

  it("reads the cooldown from the env, defaulting to 900 s", () => {
    expect(exportCooldownMs({})).toBe(900_000);
    expect(exportCooldownMs({ EXPORT_COOLDOWN_SECONDS: "" })).toBe(900_000);
    expect(exportCooldownMs({ EXPORT_COOLDOWN_SECONDS: "nope" })).toBe(900_000);
    expect(exportCooldownMs({ EXPORT_COOLDOWN_SECONDS: "-5" })).toBe(900_000);
    expect(exportCooldownMs({ EXPORT_COOLDOWN_SECONDS: "0" })).toBe(0);
    expect(exportCooldownMs({ EXPORT_COOLDOWN_SECONDS: "3600" })).toBe(3_600_000);
  });
});

describe("export counters", () => {
  it("counts granted and refused exports per UTC day, keeping the day before", async () => {
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      const day = (d: number) => Date.UTC(2026, 10, d, 12);
      expect(claimExport(i.sql, day(25), 900_000)).toEqual({ ok: true });
      expect(claimExport(i.sql, day(26), 900_000)).toEqual({ ok: true });
      expect(claimExport(i.sql, day(26) + 1_000, 900_000)).toEqual({ ok: false, retryAfter: 899 });
      expect(claimExport(i.sql, day(27), 900_000)).toEqual({ ok: true });
      expect(exportDay(i.sql, "2026-11-27")).toEqual({ exports: 1, blocked: 0 });
      expect(exportDay(i.sql, "2026-11-26")).toEqual({ exports: 1, blocked: 1 });
      expect(exportDay(i.sql, "2026-11-25")).toEqual({ exports: 0, blocked: 0 });
      const stored = JSON.parse(i.sql.exec("SELECT value FROM ops_state WHERE key = 'export_usage'").one().value as string);
      expect(Object.keys(stored.days).sort()).toEqual(["2026-11-26", "2026-11-27"]);
    });
  });

  it("counts HTTP exports in the census read, and not the console's", async () => {
    await new GatewayRPC(createExecutionContext(), env).exportData(TEST_WABA_ID, TEST_ACCOUNT_ID);
    for (let n = 0; n < 3; n++) await statusOf(exportCall());
    const today = new Date().toISOString().slice(0, 10);
    const census = await getGatewayStubForWaba(env, TEST_WABA_ID).getCensus(0, today);
    expect(census.exports).toEqual({ exports: 1, blocked: 2 });
  });
});
