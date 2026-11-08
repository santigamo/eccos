/**
 * eccos-r8x0: the daily operator census to the Telegram ops topic. Telegram's fetch is mocked;
 * the control plane and the per-WABA objects are real.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { EccosControlPlane } from "../../src/control-plane";
import { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { chunkLines, formatCensus, runDailyCensus } from "../../src/ops-census";
import worker from "../../src/worker";
import { bootstrapAccount, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

const opsEnv = {
  ...env,
  OPS_TELEGRAM_BOT_TOKEN: "test-bot-token",
  OPS_TELEGRAM_CHAT_ID: "-100123",
  OPS_TELEGRAM_THREAD_ID: "131",
} as Env;

const NOON = Date.UTC(2026, 10, 8, 12, 0, 0);
const EARLY = Date.UTC(2026, 10, 8, 6, 59, 0);

function telegramOk(): ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_thread_id: 131 } }), { status: 200 }),
  );
}

function sentTexts(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).text as string);
}

async function seedDeliveries(wabaId: string, rows: Array<[status: string, createdAt: number]>, target?: string) {
  await runInDurableObject(getGatewayStubForWaba(env, wabaId), (i: EccosGateway) => {
    if (target) i.sql.exec("INSERT OR REPLACE INTO config (key, value) VALUES ('SUBSCRIBER_WEBHOOK_URL', ?)", target);
    for (const [status, createdAt] of rows) {
      i.sql.exec(
        "INSERT INTO deliveries (payload, status, next_attempt_at, created_at) VALUES ('{}', ?, ?, ?)",
        status,
        createdAt,
        createdAt,
      );
    }
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

beforeEach(async () => {
  await bootstrapAccount();
});

describe("daily census", () => {
  it("reports accounts, WABAs, targets, delivery counts and what needs attention", async () => {
    await runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
      await cp.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_NOTARGET",
        metaAccessToken: "t",
        provisioningStatus: "active",
        onboardingType: "coexistence",
        phones: [{ phoneNumberId: "PN2", displayPhoneNumber: "+34 600 111 222" }],
      });
      await cp.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_BROKEN",
        metaAccessToken: "t",
        provisioningStatus: "failed",
        phones: [{ phoneNumberId: "PN3", displayPhoneNumber: "+34 600 333 444" }],
      });
      await cp.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_STUCK",
        metaAccessToken: "t",
        provisioningStatus: "pending",
        phones: [{ phoneNumberId: "PN4", displayPhoneNumber: "+34 600 555 666" }],
      });
      cp.sql.exec("UPDATE wabas SET created_at = ? WHERE waba_id = 'WABA_STUCK'", NOON - 25 * 3600_000);
    });
    const hour = 3600_000;
    await seedDeliveries(
      TEST_WABA_ID,
      [
        ["pending", NOON],
        ["failed", NOON - hour],
        ["failed", NOON - 40 * 24 * hour],
        ["delivered", NOON - hour],
        ["delivered", NOON - 3 * 24 * hour],
      ],
      "https://subscriber.example/hook",
    );
    await seedDeliveries("WABA_NOTARGET", [["pending", NOON], ["pending", NOON]]);
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_BROKEN"), (i: EccosGateway) => {
      i.sql.exec("INSERT INTO held_webhooks (phone_number_id, events, event_count, held_at) VALUES ('PN3', '[]', 3, ?)", NOON);
    });

    const fetchMock = telegramOk();
    await runDailyCensus(opsEnv, NOON, fetchMock as unknown as typeof fetch);

    const [text] = sentTexts(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toContain("Eccos daily census, 2026-11-08 UTC");
    expect(text).toContain("1 account, 4 WABAs (2 active, 1 pending, 1 failed)");
    expect(text).toContain(
      "Deliveries: 1 pending, 2 held: no forwarding target, 2 failed, 1 delivered (queued in the last 24 h)",
    );
    expect(text).toContain("Webhooks held: WABA not active: 3 events");
    // Only the failure from the last 24 h is flagged; the old one stays in the totals.
    expect(text).toContain(`${TEST_ACCOUNT_ID} / WABA ${TEST_WABA_ID}: 1 delivery failed in the last 24 h`);
    expect(text).toContain(`${TEST_ACCOUNT_ID} / WABA WABA_NOTARGET: 2 events held: no forwarding target`);
    expect(text).toContain(`${TEST_ACCOUNT_ID} / WABA WABA_BROKEN: provisioning failed`);
    expect(text).toContain(`${TEST_ACCOUNT_ID} / WABA WABA_BROKEN: 3 events held: WABA not active`);
    expect(text).toContain(`${TEST_ACCOUNT_ID} / WABA WABA_STUCK: provisioning pending for over 24 h`);
    expect(text).toContain(
      `WABA ${TEST_WABA_ID}, active, standard, target set: 1 pending, 0 held: no forwarding target, 2 failed, 1 delivered (queued 24 h), 0 held: WABA not active`,
    );
    expect(text).toMatch(/WABA WABA_NOTARGET, active, coexistence, sync \w+, no target: 0 pending, 2 held: no forwarding target/);
    // No numbers, tokens or secrets.
    expect(text).not.toMatch(/\+34|600|test-bot-token|tenant-token|subscriber\.example/);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.telegram.org");
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "-100123", message_thread_id: 131 });
  });

  it("flags only the coexistence syncs that need the operator", () => {
    const line = (wabaId: string, sync: string) => ({
      wabaId, status: "active", onboarding: "coexistence", sync, hasTarget: true, pending: 0, held: 0, failed: 0,
      recentFailed: 0, delivered24h: 0, heldWebhooks: 0, stuckPending: false, readable: true,
    });
    const text = formatCensus("2026-11-08", [
      {
        name: "Acme",
        organizationId: null,
        wabas: [line("W_UNCONF", "unconfirmed"), line("W_EXPIRED", "expired"), line("W_UNAVAIL", "unavailable"), line("W_NOTCOEX", "not_coexistence")],
      },
    ]);
    const attention = text.slice(text.indexOf("Needs attention"), text.indexOf("\n\n", text.indexOf("Needs attention")));
    expect(attention).toContain("W_UNCONF: coexistence sync unconfirmed");
    expect(attention).toContain("W_EXPIRED: coexistence sync expired");
    expect(attention).not.toContain("W_UNAVAIL");
    expect(attention).not.toContain("W_NOTCOEX");
    expect(text).toContain("WABA W_UNAVAIL, active, coexistence, sync unavailable");
  });

  it("reports a data plane that does not answer in time and still sends", async () => {
    vi.spyOn(EccosGateway.prototype, "getCensus").mockImplementation(() => new Promise(() => {}));
    const fetchMock = telegramOk();
    await runDailyCensus(opsEnv, NOON, fetchMock as unknown as typeof fetch, 50);
    const [text] = sentTexts(fetchMock);
    expect(text).toContain(`${TEST_ACCOUNT_ID} / WABA ${TEST_WABA_ID}: data plane unreadable`);
    expect(text).toContain(`WABA ${TEST_WABA_ID}, active, standard: unreadable`);
  });

  it("leaves the day open when gathering throws", async () => {
    vi.spyOn(EccosControlPlane.prototype, "listCensusAccounts").mockImplementation(() => {
      throw new Error("boom");
    });
    const fetchMock = telegramOk();
    await expect(runDailyCensus(opsEnv, NOON, fetchMock as unknown as typeof fetch)).rejects.toThrow();
    vi.restoreAllMocks();
    await runDailyCensus(opsEnv, NOON + 300_000, fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("splits a long census into several messages under the Telegram limit", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(100)}`);
    const chunks = chunkLines(lines, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join("\n")).toBe(lines.join("\n"));
  });

  it("sends once per UTC day, not before 07:00 UTC, and again the next day", async () => {
    const fetchMock = telegramOk();
    const run = (at: number) => runDailyCensus(opsEnv, at, fetchMock as unknown as typeof fetch);

    await run(EARLY);
    expect(fetchMock).not.toHaveBeenCalled();
    await run(Date.UTC(2026, 10, 8, 7, 0, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await runInDurableObject(getControlPlaneStub(env), (cp: EccosControlPlane) => cp.sql.exec("DELETE FROM ops_state"));

    await Promise.all([run(NOON), run(NOON + 1_000), run(NOON + 2_000)]);
    await run(NOON + 300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await run(NOON + 24 * 3600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not claim the day when the ops secrets are unset, so setting them later still sends", async () => {
    const fetchMock = telegramOk();
    await runDailyCensus(env, NOON, fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    const claimed = await runInDurableObject(getControlPlaneStub(env), (cp: EccosControlPlane) =>
      cp.sql.exec("SELECT value FROM ops_state WHERE key = 'census_day'").toArray(),
    );
    expect(claimed).toEqual([]);

    await runDailyCensus(opsEnv, NOON, fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a send Telegram rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejecting = vi.fn(async () => new Response("{}", { status: 400 }));
    await runDailyCensus(opsEnv, NOON, rejecting as unknown as typeof fetch);
    await runDailyCensus(opsEnv, NOON + 300_000, rejecting as unknown as typeof fetch);
    expect(rejecting).toHaveBeenCalledTimes(1);
  });

  it("runs from the worker's scheduled handler", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
    const telegram = telegramOk();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      String(input).includes("api.telegram.org")
        ? telegram(input, init)
        : new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    try {
      await worker.scheduled!(createScheduledController({ scheduledTime: new Date(NOON) }), opsEnv, createExecutionContext());
    } finally {
      vi.useRealTimers();
    }
    expect(telegram).toHaveBeenCalledTimes(1);
  });
});
