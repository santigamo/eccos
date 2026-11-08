/**
 * eccos-r8x0: the daily operator census to the Telegram ops topic. Telegram's fetch is mocked;
 * the control plane and the per-WABA objects are real.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import type { EccosControlPlane } from "../../src/control-plane";
import type { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { runDailyCensus } from "../../src/ops-census";
import worker from "../../src/worker";
import { bootstrapAccount, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

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
    });
    const day = NOON;
    await seedDeliveries(
      TEST_WABA_ID,
      [["pending", day], ["failed", day], ["delivered", day - 3600_000], ["delivered", day - 3 * 24 * 3600_000]],
      "https://subscriber.example/hook",
    );
    await seedDeliveries("WABA_NOTARGET", [["pending", day], ["pending", day]]);

    const fetchMock = telegramOk();
    await runDailyCensus(opsEnv, NOON, fetchMock as unknown as typeof fetch);

    const [text] = sentTexts(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toContain("Eccos daily census, 2026-11-08 UTC");
    expect(text).toContain("1 account, 3 WABAs (2 active, 1 failed)");
    expect(text).toContain("Deliveries: 1 pending, 2 held, 1 failed, 1 delivered in the last 24 h");
    expect(text).toContain(`${TEST_ACCOUNT_ID} / WABA ${TEST_WABA_ID}: 1 failed delivery`);
    expect(text).toContain(`${TEST_ACCOUNT_ID} / WABA WABA_NOTARGET: 2 events held, no forwarding target`);
    expect(text).toContain(`${TEST_ACCOUNT_ID} / WABA WABA_BROKEN: provisioning failed`);
    expect(text).toContain(`WABA ${TEST_WABA_ID}, active, standard, target set: 1 pending, 0 held, 1 failed, 1 delivered 24 h`);
    expect(text).toMatch(/WABA WABA_NOTARGET, active, coexistence, sync \w+, no target: 0 pending, 2 held/);
    expect(text).toContain("WABA WABA_BROKEN, failed, standard");
    // No numbers, tokens or secrets.
    expect(text).not.toMatch(/\+34|600|test-bot-token|tenant-token|subscriber\.example/);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.telegram.org");
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "-100123", message_thread_id: 131 });
  });

  it("sends once per UTC day, not before 07:00 UTC, and again the next day", async () => {
    const fetchMock = telegramOk();
    const run = (at: number) => runDailyCensus(opsEnv, at, fetchMock as unknown as typeof fetch);

    await run(EARLY);
    expect(fetchMock).not.toHaveBeenCalled();

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
