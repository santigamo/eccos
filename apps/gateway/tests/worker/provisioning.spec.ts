import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reset, runInDurableObject } from "cloudflare:test";
import type { EccosControlPlane } from "../../src/control-plane";
import type { EccosGateway } from "../../src/gateway";
import {
  PROVISIONING_LEASE_MS_AT_RUNTIME,
  PROVISIONING_MAX_ATTEMPTS_AT_RUNTIME,
  type ProvisioningFailure,
  type WabaProvisioningClaim,
} from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { provisionWaba, runClaim } from "../../src/provisioning";

const CALLBACK_URL = "https://gateway.example/webhooks/meta";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

async function createAccount(accountId: string): Promise<void> {
  await cp((instance) => instance.createAccount({ accountId }));
}

async function begin(
  accountId: string,
  wabaId: string,
  token = "token-v1",
  phones = [{ phoneNumberId: "PN_1", displayPhoneNumber: "+34 600 000 001" }],
) {
  return cp((instance) =>
    instance.beginWabaProvisioning({
      accountId,
      wabaId,
      metaAccessToken: token,
      callbackUrl: CALLBACK_URL,
      phones,
    }),
  );
}

function forceDue(instance: EccosControlPlane, wabaId: string): void {
  instance.sql.exec(
    "UPDATE wabas SET provisioning_next_attempt_at = ?, provisioning_lease_until = NULL WHERE waba_id = ?",
    Date.now(),
    wabaId,
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("WABA provisioning saga", () => {
  it("persists pending before external work and activates after Meta succeeds", async () => {
    const accountId = "acc-provision-success";
    const wabaId = "WABA_PROVISION_SUCCESS";
    await createAccount(accountId);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const queued = await begin(accountId, wabaId);
    expect(queued.waba.status).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();

    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_attempts, provisioning_revision FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({ status: "pending", provisioning_attempts: 0, provisioning_revision: 1 });
    });

    await provisionWaba(env, accountId, wabaId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`/${wabaId}/subscribed_apps`);
    expect(init?.headers).toMatchObject({ authorization: "Bearer token-v1" });
    expect((init?.body as URLSearchParams).get("override_callback_uri")).toBe(CALLBACK_URL);

    await cp(async (instance) => {
      expect(await instance.getWabaRecord(accountId, wabaId)).toMatchObject({
        status: "active",
        provisioningError: null,
      });
    });
    await runInDurableObject(getGatewayStubForWaba(env, wabaId), (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_WEBHOOK_CALLBACK_URL")).toBe(CALLBACK_URL);
      expect(instance.getConfigValue("CONNECTED_AT")).toEqual(expect.any(String));
    });
  });

  it("keeps retryable failures pending and resumes them after the backoff", async () => {
    const accountId = "acc-provision-retry";
    const wabaId = "WABA_PROVISION_RETRY";
    await createAccount(accountId);
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 })
        : new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    await begin(accountId, wabaId);
    await provisionWaba(env, accountId, wabaId);
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_attempts, provisioning_error, provisioning_next_attempt_at FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row?.status).toBe("pending");
      expect(row?.provisioning_attempts).toBe(1);
      expect(row?.provisioning_error).toBe("subscribed_apps failed with HTTP 503");
      expect(Number(row?.provisioning_next_attempt_at)).toBeGreaterThan(Date.now());
      forceDue(instance, wabaId);
    });

    await provisionWaba(env, accountId, wabaId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await cp(async (instance) => expect((await instance.getWabaRecord(accountId, wabaId))?.status).toBe("active"));
  });

  it("moves permanent failures to failed and explicit reconciliation requeues them", async () => {
    const accountId = "acc-provision-failed";
    const wabaId = "WABA_PROVISION_FAILED";
    await createAccount(accountId);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid token" } }), { status: 400 }),
    );

    await begin(accountId, wabaId);
    await provisionWaba(env, accountId, wabaId);
    const failedRevision = await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_attempts, provisioning_revision, provisioning_error FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({
        status: "failed",
        provisioning_attempts: 1,
        provisioning_error: "subscribed_apps failed with HTTP 400",
      });
      return row?.provisioning_revision as number;
    });

    const queued = await cp((instance) => instance.retryWabaProvisioning(accountId, wabaId));
    expect(queued).toMatchObject({ status: "pending", provisioningError: null });
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_attempts, provisioning_revision FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({
        status: "pending",
        provisioning_attempts: 0,
        provisioning_revision: failedRevision + 1,
      });
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await provisionWaba(env, accountId, wabaId);
    expect(await cp(async (instance) => (await instance.getWabaRecord(accountId, wabaId))?.status)).toBe("active");
  });

  it("does not reset a pending retry when the same desired state is submitted again", async () => {
    const accountId = "acc-provision-idempotent";
    const wabaId = "WABA_PROVISION_IDEMPOTENT";
    await createAccount(accountId);
    await begin(accountId, wabaId);
    const before = await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT provisioning_next_attempt_at, provisioning_revision FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      return { next: row?.provisioning_next_attempt_at as number, revision: row?.provisioning_revision as number };
    });
    await begin(accountId, wabaId);
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_attempts, provisioning_next_attempt_at, provisioning_revision FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({
        status: "pending",
        provisioning_attempts: 0,
        provisioning_next_attempt_at: before.next,
        provisioning_revision: before.revision,
      });
    });
  });

  it("reconciles the phone snapshot without leaving removed numbers authorized", async () => {
    const accountId = "acc-provision-phones";
    const wabaId = "WABA_PROVISION_PHONES";
    await createAccount(accountId);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    await begin(accountId, wabaId, "token-v1", [
      { phoneNumberId: "PN_KEEP", displayPhoneNumber: "+34 600 000 010" },
      { phoneNumberId: "PN_REMOVE", displayPhoneNumber: "+34 600 000 011" },
    ]);
    await provisionWaba(env, accountId, wabaId);
    await begin(accountId, wabaId, "token-v2", [
      { phoneNumberId: "PN_KEEP", displayPhoneNumber: "+34 600 000 010" },
    ]);

    await cp(async (instance) => {
      expect((await instance.getWabaRecord(accountId, wabaId))?.phones).toEqual([
        { phoneNumberId: "PN_KEEP", displayPhoneNumber: "+34 600 000 010" },
      ]);
      expect((await instance.getWabaRecord(accountId, wabaId))?.status).toBe("pending");
    });
    await provisionWaba(env, accountId, wabaId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await cp(async (instance) => expect((await instance.getWabaRecord(accountId, wabaId))?.status).toBe("active"));
  });

  // --- Gateway-stage failure (the core invariant) ---------------------------
  //
  // `runClaim` drives the saga through "meta" → "gateway". The gateway stage is
  // the last mutation before `completeWabaProvisioning`, so the interesting
  // failure mode is: Meta succeeds, but the per-WABA DO `saveConfig` rejects.
  // The row must stay "pending" (never a false active), record
  // "gateway configuration sync failed", and the data plane must hold no
  // provisioning config — the failure happened before the write.
  //
  // The gateway DO write cannot be broken through the real env: the pool's
  // `ECCOS` namespace is fixed by wrangler.vitest.jsonc, and patching the DO
  // instance method is rejected by the pool's RPC wrapper (an own property is
  // reported as "The RPC receiver does not implement the method"). Instead we
  // drive `runClaim` with a fake env (the same fake-binding pattern as
  // tests/connect-api.test.ts `makeEnv`): `ECCOS` returns a stub whose
  // `saveConfig` rejects, while `CONTROL_PLANE` delegates to the real stub so
  // the claim's completion still lands on the real row. Only the per-WABA
  // gateway write is substituted; Meta and the control plane are real.
  it("keeps the WABA pending when the gateway saveConfig fails after Meta succeeds", async () => {
    const accountId = "acc-provision-gateway-fail";
    const wabaId = "WABA_PROVISION_GATEWAY_FAIL";
    await createAccount(accountId);
    await begin(accountId, wabaId);

    const claim = await cp((instance) => instance.claimWabaProvisioning(accountId, wabaId));
    expect(claim).not.toBeNull();
    const savedConfigCalls: Record<string, string>[] = [];
    const fakeEnv = {
      META_APP_SECRET: "test-app-secret",
      META_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
      CONTROL_PLANE: {
        idFromName: () => "control-plane",
        get: () => getControlPlaneStub(env),
      },
      ECCOS: {
        idFromName: (name: string) => name,
        get: () => ({
          saveConfig: async (entries: Record<string, string>) => {
            savedConfigCalls.push(entries);
            throw new Error("config write rejected");
          },
        }),
      },
    } as unknown as Parameters<typeof runClaim>[0];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const result = await runClaim(fakeEnv, claim!);

    // Meta succeeded and the saga reached the gateway stage with the full
    // connection config, then the write failed.
    expect(result.error).toBe("gateway configuration sync failed");
    expect(savedConfigCalls).toHaveLength(1);
    expect(savedConfigCalls[0]).toMatchObject({
      META_WABA_ID: wabaId,
      META_PHONE_NUMBER_ID: "PN_1",
      DISPLAY_PHONE_NUMBER: "+34 600 000 001",
      META_WEBHOOK_CALLBACK_URL: CALLBACK_URL,
    });
    // The row stays pending (never active) with the gateway failure recorded
    // and the attempt consumed by the claim.
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_attempts, provisioning_error FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({
        status: "pending",
        provisioning_attempts: 1,
        provisioning_error: "gateway configuration sync failed",
      });
    });
    // The real per-WABA DO was never written: the failed saveConfig happened on
    // the fake stub, so the data plane holds no provisioning config.
    await runInDurableObject(getGatewayStubForWaba(env, wabaId), (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_WABA_ID")).toBeNull();
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBeNull();
      expect(instance.getConfigValue("DISPLAY_PHONE_NUMBER")).toBeNull();
      expect(instance.getConfigValue("META_WEBHOOK_CALLBACK_URL")).toBeNull();
    });
    // The pending row is retryable: with the real gateway DO healthy again the
    // next reconcile converges to active.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    await cp((instance) => forceDue(instance, wabaId));
    await provisionWaba(env, accountId, wabaId);
    expect(await cp(async (instance) => (await instance.getWabaRecord(accountId, wabaId))?.status)).toBe("active");
  });

  // --- Attempts exhaustion --------------------------------------------------
  it("fails the WABA on the sixth retryable failure", async () => {
    const accountId = "acc-provision-exhaust";
    const wabaId = "WABA_PROVISION_EXHAUST";
    await createAccount(accountId);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }),
    );

    await begin(accountId, wabaId);
    const failureMessage = "subscribed_apps failed with HTTP 503";

    // Drive the first retryable failure through the saga: attempt 1, still pending.
    await provisionWaba(env, accountId, wabaId);
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_attempts FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({ status: "pending", provisioning_attempts: 1 });
      forceDue(instance, wabaId);
    });

    // The remaining 4 retries fail retryably (attempts 2..5, still pending), then
    // attempt 6 crosses PROVISIONING_MAX_ATTEMPTS and is terminal.
    for (let attempt = 2; attempt < PROVISIONING_MAX_ATTEMPTS_AT_RUNTIME; attempt++) {
      await provisionWaba(env, accountId, wabaId);
      await cp((instance) => {
        const row = instance.sql.exec(
          "SELECT status, provisioning_attempts, provisioning_error FROM wabas WHERE waba_id = ?",
          wabaId,
        ).toArray()[0];
        expect(row).toMatchObject({ status: "pending", provisioning_attempts: attempt });
        expect(row?.provisioning_error).toBe(failureMessage);
        forceDue(instance, wabaId);
      });
    }

    await provisionWaba(env, accountId, wabaId);
    expect(fetchMock).toHaveBeenCalledTimes(PROVISIONING_MAX_ATTEMPTS_AT_RUNTIME);
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_attempts, provisioning_error FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({
        status: "failed",
        provisioning_attempts: PROVISIONING_MAX_ATTEMPTS_AT_RUNTIME,
        provisioning_error: failureMessage,
      });
    });
  });

  // --- Lease semantics ------------------------------------------------------
  it("honors the provisioning lease and re-claims after expiry", async () => {
    const accountId = "acc-provision-lease";
    const wabaId = "WABA_PROVISION_LEASE";
    await createAccount(accountId);
    await begin(accountId, wabaId);

    // Claim the row directly so the lease can be observed mid-flight (a full
    // provisionWaba would complete and clear it). ~now+60s, attempt 1.
    const claim = await cp((instance) => instance.claimWabaProvisioning(accountId, wabaId));
    expect(claim?.attempt).toBe(1);
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT provisioning_attempts, provisioning_lease_until FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row?.provisioning_attempts).toBe(1);
      expect(Number(row?.provisioning_lease_until)).toBeGreaterThan(Date.now() + PROVISIONING_LEASE_MS_AT_RUNTIME - 5_000);
      expect(Number(row?.provisioning_lease_until)).toBeLessThanOrEqual(Date.now() + PROVISIONING_LEASE_MS_AT_RUNTIME + 5_000);
    });

    // A second attempt inside the lease must not claim: no fetch, no attempt bump.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    const result = await provisionWaba(env, accountId, wabaId);
    expect(result.attempted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT provisioning_attempts FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row?.provisioning_attempts).toBe(1);
    });

    // Expire the lease, then a new provisionWaba claims again and converges.
    await cp((instance) => {
      instance.sql.exec(
        "UPDATE wabas SET provisioning_lease_until = ?, provisioning_next_attempt_at = ? WHERE waba_id = ?",
        Date.now() - 1,
        Date.now(),
        wabaId,
      );
    });
    const retried = await provisionWaba(env, accountId, wabaId);
    expect(retried.attempted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await cp(async (instance) => (await instance.getWabaRecord(accountId, wabaId))?.status)).toBe("active");
  });

  // --- Revision guard -------------------------------------------------------
  it("ignores a stale completion after a new provisioning batch bumps the revision", async () => {
    const accountId = "acc-provision-revision-guard";
    const wabaId = "WABA_PROVISION_REVISION_GUARD";
    await createAccount(accountId);
    // Meta fails once so the row stays pending at revision 1, attempt 1.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }),
    );
    await begin(accountId, wabaId);
    await provisionWaba(env, accountId, wabaId);
    const stale = await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT provisioning_revision, provisioning_attempts FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      return {
        revision: row?.provisioning_revision as number,
        attempt: row?.provisioning_attempts as number,
      };
    });
    expect(stale.revision).toBe(1);
    expect(stale.attempt).toBe(1);

    // Re-beginning bumps the revision (fingerprint changed → revision 2) and
    // resets attempts to 0 — the old claim is now stale.
    await begin(accountId, wabaId, "token-v2");
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT provisioning_revision, provisioning_attempts FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({ provisioning_revision: stale.revision + 1, provisioning_attempts: 0 });
    });

    // A stale completion carrying the old revision/attempt must be a no-op: the
    // row stays pending at revision 2, never a false active.
    const outcome = await cp((instance) =>
      instance.completeWabaProvisioning({
        accountId,
        wabaId,
        revision: stale.revision,
        attempt: stale.attempt,
        success: true,
      }),
    );
    expect(outcome?.status).toBe("pending");
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_revision, provisioning_attempts FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({
        status: "pending",
        provisioning_revision: stale.revision + 1,
        provisioning_attempts: 0,
      });
    });
  });

  // --- Meta failure ⇒ no gateway write --------------------------------------
  it("does not write gateway config when Meta fails terminally", async () => {
    const accountId = "acc-provision-no-gateway-400";
    const wabaId = "WABA_PROVISION_NO_GATEWAY_400";
    await createAccount(accountId);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid token" } }), { status: 400 }),
    );
    await begin(accountId, wabaId);
    await provisionWaba(env, accountId, wabaId);
    await cp(async (instance) => {
      expect(await instance.getWabaRecord(accountId, wabaId)).toMatchObject({
        status: "failed",
        provisioningError: "subscribed_apps failed with HTTP 400",
      });
    });
    await runInDurableObject(getGatewayStubForWaba(env, wabaId), (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_WABA_ID")).toBeNull();
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBeNull();
      expect(instance.getConfigValue("DISPLAY_PHONE_NUMBER")).toBeNull();
      expect(instance.getConfigValue("META_WEBHOOK_CALLBACK_URL")).toBeNull();
    });
  });

  it("does not write gateway config on a retryable Meta failure", async () => {
    const accountId = "acc-provision-no-gateway-503";
    const wabaId = "WABA_PROVISION_NO_GATEWAY_503";
    await createAccount(accountId);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }),
    );
    await begin(accountId, wabaId);
    await provisionWaba(env, accountId, wabaId);
    await cp((instance) => {
      const row = instance.sql.exec(
        "SELECT status, provisioning_error FROM wabas WHERE waba_id = ?",
        wabaId,
      ).toArray()[0];
      expect(row).toMatchObject({
        status: "pending",
        provisioning_error: "subscribed_apps failed with HTTP 503",
      });
    });
    await runInDurableObject(getGatewayStubForWaba(env, wabaId), (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_WABA_ID")).toBeNull();
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBeNull();
      expect(instance.getConfigValue("DISPLAY_PHONE_NUMBER")).toBeNull();
      expect(instance.getConfigValue("META_WEBHOOK_CALLBACK_URL")).toBeNull();
    });
  });

  // --- Happy-path config completeness ---------------------------------------
  it("writes the full connection config to the gateway DO on success", async () => {
    const accountId = "acc-provision-config";
    const wabaId = "WABA_PROVISION_CONFIG";
    await createAccount(accountId);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    await begin(accountId, wabaId);
    await provisionWaba(env, accountId, wabaId);

    await runInDurableObject(getGatewayStubForWaba(env, wabaId), (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_WABA_ID")).toBe(wabaId);
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBe("PN_1");
      expect(instance.getConfigValue("DISPLAY_PHONE_NUMBER")).toBe("+34 600 000 001");
      expect(instance.getConfigValue("META_WEBHOOK_CALLBACK_URL")).toBe(CALLBACK_URL);
      expect(instance.getConfigValue("CONNECTED_AT")).toEqual(expect.any(String));
    });
  });
});
