import { env, exports } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import type { EccosControlPlane } from "../../src/control-plane";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { bootstrapAccount, TEST_WABA_ID } from "./helpers";

let API_KEY = "ek-test";
let ACCOUNT_ID = "test-account";

/** Meta Graph mock that answers every endpoint with success. */
function metaOkMock(): MockInstance<typeof fetch> {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

beforeEach(async () => {
  const boot = await bootstrapAccount();
  API_KEY = boot.apiKey;
  ACCOUNT_ID = boot.accountId;
});

describe("POST /connect/exchange", () => {
  it("registers the WABA + phones under the authenticated account after Meta exchange", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "biz-token" }), { status: 200 });
      }
      if (url.includes("/debug_token")) {
        return new Response(
          JSON.stringify({
            data: {
              granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA123"] }],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/phone_numbers")) {
        return new Response(
          JSON.stringify({ data: [{ id: "PNID", display_phone_number: "+34 600 000 000" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/subscribed_apps")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    // Start an account-bound connect state.
    const state = "state-exchange";
    await runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
      cp.startConnectState(state, ACCOUNT_ID, Date.now() + 60_000);
    });

    const res = await exports.default.fetch("https://example.com/connect/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ code: "oauth-code", state, waba_id: "WABA123" }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      ok: true,
      waba_id: "WABA123",
      phone_number_id: "PNID",
      status: "pending",
    });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/subscribed_apps"));

    const reconcile = await exports.default.fetch(`https://example.com/v1/accounts/${ACCOUNT_ID}/wabas/WABA123/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ECCOS_ADMIN_API_KEY}` },
    });
    expect(reconcile.status).toBe(200);
    await runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
      expect(cp.getWaba(ACCOUNT_ID, "WABA123")?.status).toBe("active");
    });

    await runInDurableObject(getGatewayStubForWaba(env, "WABA123"), async (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBe("PNID");
      expect(instance.getConfigValue("META_WABA_ID")).toBe("WABA123");
      expect(instance.getConfigValue("DISPLAY_PHONE_NUMBER")).toBe("+34 600 000 000");
    });
  });

  it("reconcile auto-requeues a failed WABA: failed -> pending -> active in one call", async () => {
    const wabaId = "WABA_RECONCILE_FAILED";
    await runInDurableObject(getControlPlaneStub(env), (instance: EccosControlPlane) => {
      instance.registerWaba({
        accountId: ACCOUNT_ID,
        wabaId,
        metaAccessToken: "failed-token",
        callbackUrl: "https://gateway.example/webhooks/meta",
        provisioningStatus: "failed",
        phones: [{ phoneNumberId: "PNID_RECONCILE_FAILED" }],
      });
    });
    const fetchMock = metaOkMock();

    const res = await exports.default.fetch(`https://example.com/v1/accounts/${ACCOUNT_ID}/wabas/${wabaId}/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ECCOS_ADMIN_API_KEY}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      waba: { accountId: ACCOUNT_ID, wabaId, status: "active", provisioningError: null },
    });
    // Exactly one subscribed_apps call: the requeued attempt.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes(`/${wabaId}/subscribed_apps`)),
    ).toHaveLength(1);
    await runInDurableObject(getControlPlaneStub(env), (instance: EccosControlPlane) => {
      expect(instance.getWaba(ACCOUNT_ID, wabaId)?.status).toBe("active");
    });
  });

  it("reconcile on an already-active WABA is a no-op: no second subscribed_apps call", async () => {
    const wabaId = "WABA_RECONCILE_ACTIVE";
    await runInDurableObject(getControlPlaneStub(env), (instance: EccosControlPlane) => {
      instance.registerWaba({
        accountId: ACCOUNT_ID,
        wabaId,
        metaAccessToken: "active-token",
        provisioningStatus: "active",
        phones: [{ phoneNumberId: "PNID_RECONCILE_ACTIVE" }],
      });
    });
    const fetchMock = metaOkMock();

    const res = await exports.default.fetch(`https://example.com/v1/accounts/${ACCOUNT_ID}/wabas/${wabaId}/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ECCOS_ADMIN_API_KEY}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ waba: { wabaId, status: "active" } });
    // No work happened: the already-active WABA was not re-claimed, so Meta was
    // never called for it (attempted: false semantics).
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
