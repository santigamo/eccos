import { env } from "cloudflare:workers";
import { createScheduledController, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import type { EccosGateway } from "../../src/gateway";
import worker from "../../src/worker";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { bootstrapAccount, TEST_ACCOUNT_ID } from "./helpers";

const CALLBACK_URL = "https://gateway.example/webhooks/meta";

/**
 * Drives the worker's `scheduled` handler the same way the cron trigger (every
 * 5 minutes, per the crons schedule in wrangler.jsonc) does: the main module's
 * default export is imported directly (the vitest-pool-workers main module
 * runs in the same isolate as the tests), so this exercises
 * `reconcilePendingWabas(env)` with the real test env and any global fetch
 * mocks applied.
 */
function runScheduled(): Promise<void> {
  return worker.scheduled(createScheduledController({ scheduledTime: new Date() }), env);
}

async function registerPending(wabaId: string, phoneId: string): Promise<void> {
  await runInDurableObject(getControlPlaneStub(env), (instance: EccosControlPlane) =>
    instance.beginWabaProvisioning({
      accountId: TEST_ACCOUNT_ID,
      wabaId,
      metaAccessToken: "cron-token",
      callbackUrl: CALLBACK_URL,
      phones: [{ phoneNumberId: phoneId, displayPhoneNumber: "+34 600 000 001" }],
    }),
  );
}

function metaOkMock(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

beforeEach(async () => {
  await bootstrapAccount();
});

describe("scheduled handler", () => {
  it("purges expired connect states without removing live handoffs", async () => {
    await runInDurableObject(getControlPlaneStub(env), (instance: EccosControlPlane) => {
      instance.startConnectState("WABA_CRON_EXPIRED_STATE", TEST_ACCOUNT_ID, Date.now() + 60_000);
      instance.sql.exec(
        "UPDATE connect_states SET expires_at = ? WHERE state = ?",
        Date.now() - 1,
        "WABA_CRON_EXPIRED_STATE",
      );
      instance.startConnectState("WABA_CRON_LIVE_STATE", TEST_ACCOUNT_ID, Date.now() + 60_000);
    });

    await runScheduled();

    await runInDurableObject(getControlPlaneStub(env), (instance: EccosControlPlane) => {
      expect(instance.getConnectState("WABA_CRON_EXPIRED_STATE")).toBeNull();
      expect(instance.getConnectState("WABA_CRON_LIVE_STATE")).toMatchObject({ accountId: TEST_ACCOUNT_ID });
    });
  });

  it("drives a due, unleased pending row to active and configures its gateway DO", async () => {
    await registerPending("WABA_CRON_ACTIVATE", "PN_CRON_ACTIVATE");
    const fetchMock = metaOkMock();

    await runScheduled();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/WABA_CRON_ACTIVATE/subscribed_apps");

    await runInDurableObject(getControlPlaneStub(env), async (instance: EccosControlPlane) => {
      expect(await instance.getWabaRecord(TEST_ACCOUNT_ID, "WABA_CRON_ACTIVATE")).toMatchObject({
        status: "active",
        provisioningError: null,
      });
    });
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_CRON_ACTIVATE"), (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_WABA_ID")).toBe("WABA_CRON_ACTIVATE");
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBe("PN_CRON_ACTIVATE");
      expect(instance.getConfigValue("META_WEBHOOK_CALLBACK_URL")).toBe(CALLBACK_URL);
      expect(instance.getConfigValue("CONNECTED_AT")).toEqual(expect.any(String));
    });
  });

  it("skips pending rows that are still leased or not yet due (backoff respected)", async () => {
    await registerPending("WABA_CRON_LEASED", "PN_CRON_LEASED");
    await registerPending("WABA_CRON_NOT_DUE", "PN_CRON_NOT_DUE");
    await runInDurableObject(getControlPlaneStub(env), (instance: EccosControlPlane) => {
      // WABA_CRON_LEASED is due but another worker still holds its lease.
      instance.sql.exec(
        "UPDATE wabas SET provisioning_lease_until = ? WHERE waba_id = ?",
        Date.now() + 60_000,
        "WABA_CRON_LEASED",
      );
      // WABA_CRON_NOT_DUE sits inside its backoff window.
      instance.sql.exec(
        "UPDATE wabas SET provisioning_next_attempt_at = ?, provisioning_lease_until = NULL WHERE waba_id = ?",
        Date.now() + 60_000,
        "WABA_CRON_NOT_DUE",
      );
    });
    const fetchMock = metaOkMock();

    await runScheduled();

    expect(fetchMock).not.toHaveBeenCalled();
    await runInDurableObject(getControlPlaneStub(env), (instance: EccosControlPlane) => {
      for (const wabaId of ["WABA_CRON_LEASED", "WABA_CRON_NOT_DUE"]) {
        const row = instance.sql
          .exec("SELECT status, provisioning_attempts FROM wabas WHERE waba_id = ?", wabaId)
          .toArray()[0];
        expect(row).toMatchObject({ status: "pending", provisioning_attempts: 0 });
      }
    });
  });

  it("claims each due pending row at most once per run", async () => {
    const wabas = ["WABA_CRON_A", "WABA_CRON_B", "WABA_CRON_C"];
    for (const [index, wabaId] of wabas.entries()) {
      await registerPending(wabaId, `PN_CRON_${index}`);
    }
    const fetchMock = metaOkMock();

    await runScheduled();

    expect(fetchMock).toHaveBeenCalledTimes(wabas.length);
    for (const wabaId of wabas) {
      const subscribedCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes(`/${wabaId}/subscribed_apps`),
      );
      expect(subscribedCalls).toHaveLength(1);
    }
    await runInDurableObject(getControlPlaneStub(env), async (instance: EccosControlPlane) => {
      for (const wabaId of wabas) {
        expect((await instance.getWabaRecord(TEST_ACCOUNT_ID, wabaId))?.status).toBe("active");
      }
    });
  });
});
