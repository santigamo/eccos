import { env, exports } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import type { EccosControlPlane } from "../../src/control-plane";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { bootstrapAccount, TEST_WABA_ID } from "./helpers";
import { SMB_APP_DATA_EDGE } from "../../src/meta/smb-app-data";

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
    const graph = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
      // Before spending the once-only syncs, the saga asks Meta what the
      // onboarding actually produced. Here it answers "a coexistence number",
      // which is what unlocks the two sync calls asserted below (eccos-vss).
      if (url.includes("is_on_biz_app")) {
        return new Response(
          JSON.stringify({ id: "PNID", is_on_biz_app: true, platform_type: "CLOUD_API" }),
          { status: 200 },
        );
      }
      // /connect is the WhatsApp Business app onboarding flow, so provisioning
      // also initiates the coexistence contacts + message-history syncs Meta
      // requires (eccos-vss).
      if (url.includes(SMB_APP_DATA_EDGE)) {
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
    // eccos-lpk: the exchange provisions before answering, so the caller is told
    // "active", not "pending until some cron runs".
    expect(await res.json()).toMatchObject({
      ok: true,
      waba_id: "WABA123",
      phone_number_id: "PNID",
      status: "active",
    });
    const subscribed = () =>
      graph.mock.calls.filter(([input]) => String(input).includes("/subscribed_apps"));
    expect(subscribed()).toHaveLength(1);
    // The number stays on the customer's WhatsApp Business app, so Meta requires
    // contacts and message-history synchronisation to be initiated after the
    // handoff — one call each for the one registered number (eccos-vss).
    expect(
      graph.mock.calls.filter(([input]) => String(input).includes(SMB_APP_DATA_EDGE)),
    ).toHaveLength(2);
    await runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
      const waba = await cp.getWaba(ACCOUNT_ID, "WABA123");
      expect(waba?.status).toBe("active");
      // Recorded as a coexistence onboarding, with both syncs initiated inside
      // the 24-hour window.
      expect(waba?.coexistence.onboardingType).toBe("coexistence");
      expect(waba?.coexistence.status).toBe("initiated");
      expect(waba?.coexistence.deadlineAt).toBeGreaterThan(Date.now());
    });

    // The cron's targeted path stays idempotent behind it: nothing left to claim.
    const reconcile = await exports.default.fetch(`https://example.com/v1/accounts/${ACCOUNT_ID}/wabas/WABA123/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ECCOS_ADMIN_API_KEY}` },
    });
    expect(reconcile.status).toBe(200);
    expect(subscribed()).toHaveLength(1);
    await runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
      expect((await cp.getWaba(ACCOUNT_ID, "WABA123"))?.status).toBe("active");
    });

    await runInDurableObject(getGatewayStubForWaba(env, "WABA123"), async (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBe("PNID");
      expect(instance.getConfigValue("META_WABA_ID")).toBe("WABA123");
      expect(instance.getConfigValue("DISPLAY_PHONE_NUMBER")).toBe("+34 600 000 000");
    });
  });

  it("reconcile auto-requeues a failed WABA: failed -> pending -> active in one call", async () => {
    const wabaId = "WABA_RECONCILE_FAILED";
    await runInDurableObject(getControlPlaneStub(env), async (instance: EccosControlPlane) => {
      await instance.registerWaba({
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
    await runInDurableObject(getControlPlaneStub(env), async (instance: EccosControlPlane) => {
      expect((await instance.getWaba(ACCOUNT_ID, wabaId))?.status).toBe("active");
    });
  });

  it("reconcile on an already-active WABA is a no-op: no second subscribed_apps call", async () => {
    const wabaId = "WABA_RECONCILE_ACTIVE";
    await runInDurableObject(getControlPlaneStub(env), async (instance: EccosControlPlane) => {
      await instance.registerWaba({
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

/**
 * The Facebook Login for Business dialog URL, after the Embedded Signup v4
 * migration.
 *
 * v2 needed an `extras` object to ask for the WhatsApp Business app flow. It
 * never worked here — `extras` is documented only as an `FB.login()` option and
 * the dialog was observed on 2026-09-01 to ignore it — and under v4 there is
 * nothing left for it to carry: the flow's products and version come from the
 * configuration behind `config_id`. This pins that the URL now says only what
 * Meta documents it can say.
 */
describe("the Embedded Signup dialog URL (v4)", () => {
  async function dialogUrl(): Promise<URL> {
    metaOkMock();
    const start = await exports.default.fetch("https://example.com/connect/start", {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const { url } = (await start.json()) as { url: string };
    const redirect = await exports.default.fetch(url, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    return new URL(redirect.headers.get("location") ?? "");
  }

  it("carries no extras — the v4 flow is defined by the login configuration", async () => {
    const url = await dialogUrl();
    expect(url.searchParams.get("extras")).toBeNull();
    // And in particular none of the three things the v2 payload used to carry.
    expect(url.search).not.toContain("featureType");
    expect(url.search).not.toContain("whatsapp_business_app_onboarding");
    expect(url.search).not.toContain("sessionInfoVersion");
  });

  it("carries exactly the parameters Meta documents for the manual login flow", async () => {
    const url = await dialogUrl();
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v25.0/dialog/oauth");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "config_id",
      "override_default_response_type",
      "redirect_uri",
      "response_type",
      "state",
    ]);
    // The configuration id is the whole of the flow's identity now, so it must
    // actually travel.
    expect(url.searchParams.get("config_id")).toBe("test-config-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
  });
});
