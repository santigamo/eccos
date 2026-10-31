/**
 * eccos-brqz: webhooks of a registered WABA that is pending (provisioning or a re-run
 * Embedded Signup) are held in its Durable Object and forwarded once it is active again.
 */
import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import type { EccosGateway } from "../../src/gateway";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { HELD_MAX_AGE_MS, HELD_MAX_EVENTS } from "../../src/held-webhooks";
import { provisionWaba } from "../../src/provisioning";
import { bootstrapAccount, gatewayStub, SUBSCRIBER_URL, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await bootstrapAccount();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function lines(event: string): Record<string, unknown>[] {
  return log.mock.calls
    .map(([arg]) => (typeof arg === "string" && arg.startsWith("{") ? JSON.parse(arg) : null))
    .filter((line) => line?.event === event);
}

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function inboundCount(): Promise<number> {
  return runInDurableObject(gatewayStub(), (instance: EccosGateway) => instance.getCounts().inbound);
}

function heldRows(): Promise<number> {
  return runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
    Number(instance.sql.exec("SELECT COUNT(*) AS n FROM held_webhooks").one().n),
  );
}

async function post(wabaId: string, messageId: string, phoneNumberId = "PNID1") {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: wabaId,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: phoneNumberId },
          messages: [{ from: "34600000000", id: messageId, timestamp: "1700000000", type: "text", text: { body: "secret text" } }],
        },
      }],
    }],
  });
  return exports.default.fetch("http://example.com/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
    body,
  });
}

/** Re-runs Embedded Signup on the active test WABA, which sets it back to pending. */
function reprovision() {
  return cp((instance) =>
    instance.beginWabaProvisioning({
      accountId: TEST_ACCOUNT_ID,
      wabaId: TEST_WABA_ID,
      metaAccessToken: "token-v2",
      callbackUrl: "https://gateway.example/webhooks/meta",
      phones: [{ phoneNumberId: "PNID1", displayPhoneNumber: "+34600000000" }],
    }),
  );
}

describe("held webhooks", () => {
  it("holds events while a WABA re-provisions and forwards them once it is active", async () => {
    await gatewayStub().saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL });
    await reprovision();

    const response = await post(TEST_WABA_ID, "wamid.HELD");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, received: 0 });
    expect(await inboundCount()).toBe(0);
    expect(await heldRows()).toBe(1);
    expect(lines("webhook_held")).toEqual([
      expect.objectContaining({ wabaId: TEST_WABA_ID, phoneNumberId: "PNID1", eventCount: 1, heldEvents: 1 }),
    ]);
    expect(lines("webhook_ignored")).toEqual([]);

    const forwarded: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === SUBSCRIBER_URL) forwarded.push(String(init?.body));
      return new Response("ok", { status: 200 });
    });
    expect(await provisionWaba(env, TEST_ACCOUNT_ID, TEST_WABA_ID)).toMatchObject({ attempted: true, error: null });

    expect(await heldRows()).toBe(0);
    expect(await inboundCount()).toBe(1);
    expect(lines("held_released")).toEqual([
      expect.objectContaining({ wabaId: TEST_WABA_ID, released: 1, discarded: 0 }),
    ]);
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => instance.alarm());
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toContain("wamid.HELD");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret text");
  });

  it("releases on the next webhook when activation raced the hold", async () => {
    await reprovision();
    await post(TEST_WABA_ID, "wamid.RACE_HELD");
    await cp((instance) => instance.sql.exec("UPDATE wabas SET status = 'active' WHERE waba_id = ?", TEST_WABA_ID));

    const response = await post(TEST_WABA_ID, "wamid.RACE_LIVE");
    expect(await response.json()).toEqual({ ok: true, received: 1 });
    await vi.waitFor(async () => expect(await inboundCount()).toBe(2));
    expect(await heldRows()).toBe(0);
  });

  it("discards held events of a phone the activated WABA does not register", async () => {
    await reprovision();
    await post(TEST_WABA_ID, "wamid.OTHER_PHONE", "PN_FOREIGN");
    const result = await runInDurableObject(gatewayStub(), (instance: EccosGateway) => instance.releaseHeld(["PNID1"]));
    expect(result).toEqual({ released: 0, discarded: 1 });
    expect(await inboundCount()).toBe(0);
  });

  it("erases a customer's held events so a release cannot bring them back", async () => {
    await reprovision();
    await post(TEST_WABA_ID, "wamid.ERASE");
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      expect(await instance.eraseByPhone("+34600000000")).toMatchObject({ ok: true, counts: { inboundEventsDeleted: 1 } });
      expect(instance.releaseHeld(["PNID1"])).toEqual({ released: 0, discarded: 0 });
    });
    expect(await inboundCount()).toBe(0);
  });

  it("keeps ignoring failed and unknown WABAs", async () => {
    await cp((instance) =>
      instance.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_FAILED",
        metaAccessToken: "failed-token",
        provisioningStatus: "failed",
        phones: [{ phoneNumberId: "PN_FAILED" }],
      }),
    );
    expect((await post("WABA_FAILED", "wamid.F", "PN_FAILED")).status).toBe(200);
    expect((await post("WABA_UNKNOWN", "wamid.U", "PN_UNKNOWN")).status).toBe(200);

    expect(lines("webhook_held")).toEqual([]);
    expect(lines("webhook_ignored").map((line) => [line.wabaId, line.reason])).toEqual([
      ["WABA_FAILED", "inactive_waba"],
      ["WABA_UNKNOWN", "unknown_waba"],
    ]);
  });

  it("refuses to hold past the event cap", async () => {
    await reprovision();
    const filler: WhatsAppCallbackEvent[] = Array.from({ length: HELD_MAX_EVENTS }, (_, i) => ({
      type: "reply",
      from: "34600000000",
      messageId: `wamid.FILL${i}`,
      text: "x",
      at: 1_700_000_000_000,
    }));
    expect(await gatewayStub().hold("PNID1", filler)).toMatchObject({ held: true });

    expect((await post(TEST_WABA_ID, "wamid.OVER")).status).toBe(200);
    expect(lines("webhook_ignored")).toEqual([
      expect.objectContaining({ reason: "hold_full", wabaId: TEST_WABA_ID, eventCount: 1 }),
    ]);
    expect(await heldRows()).toBe(1);
  });

  it("expires held events past the age bound on the retention sweep", async () => {
    await reprovision();
    await post(TEST_WABA_ID, "wamid.OLD");
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      instance.sql.exec("UPDATE held_webhooks SET held_at = ?", Date.now() - HELD_MAX_AGE_MS - 1);
      await instance.alarm();
    });
    expect(await heldRows()).toBe(0);
    expect(lines("held_expired")).toEqual([expect.objectContaining({ wabaId: TEST_WABA_ID, eventCount: 1 })]);
  });
});
