import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { GatewayRPC } from "../../src/rpc";
import type { EccosControlPlane } from "../../src/control-plane";
import type { EccosGateway } from "../../src/gateway";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { alarmOf, holdAlarms } from "./helpers";

const ACCOUNT = "acc-remove";
const PHONE = { phoneNumberId: "PN_REMOVE_1", displayPhoneNumber: "+34 600 000 101" };

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function register(accountId: string, wabaId: string, provisioningStatus: "active" | "failed" = "active", phone = PHONE) {
  return cp((i) =>
    i.registerWabas([{ accountId, wabaId, metaAccessToken: "token-remove", provisioningStatus, phones: [phone] }]),
  );
}

async function createAccount(accountId: string, policy?: "setup"): Promise<void> {
  await cp(async (i) => {
    await i.createAccount({ accountId });
    if (policy) i.sql.exec("UPDATE accounts SET connect_policy = ? WHERE account_id = ?", policy, accountId);
  });
}

function subscriberClaim(selector: string, wabaId: string): Promise<void> {
  return cp((i) => {
    i.sql.exec(
      `INSERT INTO secret_claims (selector, account_id, hash, kind, waba_id, creator_user_id, client_id, created_at, expires_at)
       VALUES (?, ?, 'h', 'subscriber_secret', ?, 'user', 'client', ?, ?)`,
      selector,
      ACCOUNT,
      wabaId,
      Date.now(),
      Date.now() + 60_000,
    );
  });
}

const resources = (accountId: string) => cp((i) => i.listAccountResources(accountId));
const rpc = () => new GatewayRPC(createExecutionContext(), env);
const logLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => JSON.parse(String(call[0])));

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("GatewayRPC.removeWaba", () => {
  it("frees a setup account's number and phone_number_id for a new WABA", async () => {
    await createAccount(ACCOUNT, "setup");
    await register(ACCOUNT, "WABA_OLD", "failed");
    expect((await resources(ACCOUNT)).account?.canAddNumber).toBe(false);
    await expect(register(ACCOUNT, "WABA_NEW")).rejects.toThrow();

    const audit = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(rpc().removeWaba(" WABA_OLD ", ACCOUNT)).resolves.toBe(true);
    expect(logLines(audit)).toEqual([
      { event: "waba_removed", accountId: ACCOUNT, wabaId: "WABA_OLD", changed: true, phoneNumberIds: [PHONE.phoneNumberId] },
    ]);

    const after = await resources(ACCOUNT);
    expect(after.wabas).toEqual([]);
    expect(after.account?.canAddNumber).toBe(true);
    const [result] = await register(ACCOUNT, "WABA_NEW");
    expect(result?.phones.map((phone) => phone.phoneNumberId)).toEqual([PHONE.phoneNumberId]);
    await expect(rpc().removeWaba("WABA_OLD", ACCOUNT)).resolves.toBe(false);
  });

  it("refuses another account's WABA without changing it", async () => {
    await createAccount(ACCOUNT);
    await createAccount("acc-remove-other");
    await register(ACCOUNT, "WABA_OWNED", "failed");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      rpc().removeWaba("WABA_OWNED", "acc-remove-other", { confirmActiveWabaId: "WABA_OWNED" }),
    ).resolves.toBe(false);
    expect((await resources(ACCOUNT)).phones).toHaveLength(1);
  });

  it("removes an active WABA with phones only when confirmActiveWabaId repeats its id", async () => {
    await createAccount(ACCOUNT);
    await register(ACCOUNT, "WABA_LIVE");
    const audit = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(rpc().removeWaba("WABA_LIVE", ACCOUNT)).rejects.toThrow(/active/);
    await expect(rpc().removeWaba("WABA_LIVE", ACCOUNT, { confirmActiveWabaId: "WABA_OTHER" })).rejects.toThrow(/active/);
    expect(logLines(audit)[0]).toMatchObject({ event: "waba_remove_refused", changed: false, error: expect.stringMatching(/active/) });
    expect((await resources(ACCOUNT)).wabas).toHaveLength(1);

    await expect(rpc().removeWaba("WABA_LIVE", ACCOUNT, { confirmActiveWabaId: "WABA_LIVE" })).resolves.toBe(true);
    expect((await resources(ACCOUNT)).wabas).toEqual([]);
  });

  it("removes a pending WABA without the confirmation, but not while a provisioning attempt holds its lease", async () => {
    await createAccount(ACCOUNT);
    await cp((i) =>
      i.beginWabaProvisioning({ accountId: ACCOUNT, wabaId: "WABA_PENDING", metaAccessToken: "token-remove", callbackUrl: "https://gateway.example/webhooks/meta", phones: [PHONE] }),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const lease = (until: number | null) =>
      cp((i) => i.sql.exec("UPDATE wabas SET provisioning_lease_until = ? WHERE waba_id = 'WABA_PENDING'", until));

    await lease(Date.now() + 30_000);
    await expect(rpc().removeWaba("WABA_PENDING", ACCOUNT)).rejects.toThrow(/being provisioned/);
    await lease(null);
    await expect(rpc().removeWaba("WABA_PENDING", ACCOUNT)).resolves.toBe(true);
  });

  it("leaves sibling WABAs and their secret claims alone, and cancels the removed WABA's", async () => {
    await createAccount(ACCOUNT);
    await register(ACCOUNT, "WABA_GONE", "failed");
    await register(ACCOUNT, "WABA_KEPT", "active", { phoneNumberId: "PN_REMOVE_2", displayPhoneNumber: "+34 600 000 102" });
    await subscriberClaim("claim-gone", "WABA_GONE");
    await subscriberClaim("claim-kept", "WABA_KEPT");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(rpc().removeWaba("WABA_GONE", ACCOUNT)).resolves.toBe(true);

    const after = await resources(ACCOUNT);
    expect(after.wabas.map((w) => w.wabaId)).toEqual(["WABA_KEPT"]);
    expect(after.phones.map((p) => p.phoneNumberId)).toEqual(["PN_REMOVE_2"]);
    const claims = await cp((i) => i.sql.exec("SELECT selector, cancelled_at FROM secret_claims ORDER BY selector").toArray());
    expect(claims).toEqual([
      { selector: "claim-gone", cancelled_at: expect.any(Number) },
      { selector: "claim-kept", cancelled_at: null },
    ]);
  });
});

describe("the data plane of a WABA the control plane does not know", () => {
  const stub = () => getGatewayStubForWaba(env, "WABA_REMOVED");
  const alarmAfterRun = () =>
    runInDurableObject(stub(), async (instance: EccosGateway, state: DurableObjectState) => {
      await state.storage.deleteAlarm();
      await alarmOf(instance);
      return state.storage.getAlarm();
    });

  it("does not arm a past alarm for a failed media download it can no longer retry", async () => {
    await holdAlarms(stub());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await stub().ingest([
      { type: "message", from: "34600000001", messageId: "wamid.M1", at: Date.now(), phoneNumberId: "PN", messageType: "image", media: { id: "9001", mimeType: "image/jpeg" } },
    ]);
    await runInDurableObject(stub(), (i: EccosGateway) => {
      i.sql.exec(
        "INSERT INTO media (media_id, state, attempts, next_attempt_at, updated_at) VALUES ('9001', 'failed', 1, ?, ?)",
        Date.now() - 1_000,
        Date.now(),
      );
    });

    expect((await alarmAfterRun()) ?? Number.POSITIVE_INFINITY).toBeGreaterThan(Date.now());
  });

  it("does not retry an unprocessed sync payload every minute", async () => {
    await holdAlarms(stub());
    await runInDurableObject(stub(), (i: EccosGateway) => i.captureSyncPayload(["history"], JSON.stringify({ history: [] })));

    expect((await alarmAfterRun()) ?? Number.POSITIVE_INFINITY).toBeGreaterThan(Date.now() + 60_000);
  });
});
