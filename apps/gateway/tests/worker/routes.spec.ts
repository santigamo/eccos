import { env, exports } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { provisionWaba } from "../../src/provisioning";
import { bootstrapAccount, metaEnvelope, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

let API_KEY = "ek-test";

function mockGraphFetch(): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/messages")) {
      return new Response(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/message_templates")) {
      return new Response(
        JSON.stringify({ data: [{ name: "hello_world", language: "en_US", status: "APPROVED" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (String(init?.method ?? "GET").toUpperCase() === "POST") {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(async () => {
  const boot = await bootstrapAccount();
  API_KEY = boot.apiKey;
});

afterEach(async () => {
  delete (env as { SEND_RATE_LIMITER?: RateLimit }).SEND_RATE_LIMITER;
  vi.restoreAllMocks();
  await reset();
});

describe("routes", () => {
  it("GET /health returns ok", async () => {
    const res = await exports.default.fetch("http://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "eccos", version: "0.1.0" });
  });

  it("GET /webhooks/meta verifies challenge token", async () => {
    const ok = await exports.default.fetch(
      `http://example.com/webhooks/meta?hub.mode=subscribe&hub.verify_token=${env.META_WEBHOOK_VERIFY_TOKEN}&hub.challenge=abc123`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("abc123");

    const bad = await exports.default.fetch(
      "http://example.com/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123",
    );
    expect(bad.status).toBe(403);
  });

  it("POST /webhooks/meta validates signature and JSON", async () => {
    const payload = metaEnvelope({
      statuses: [{ id: "wamid.D", status: "delivered", timestamp: "1700000000" }],
    });
    const body = JSON.stringify(payload);
    const signature = await signPayload(body, env.META_APP_SECRET);

    const ok = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, received: 1 });

    const badSig = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body,
    });
    expect(badSig.status).toBe(401);

    const badJson = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await signPayload("not-json", env.META_APP_SECRET),
      },
      body: "not-json",
    });
    expect(badJson.status).toBe(400);
  });

  it("routes webhook entries to their WABA objects", async () => {
    // Register the target WABAs so the account-scoped webhook filter ingests them.
    await bootstrapAccount(TEST_ACCOUNT_ID, "WABA_A", [{ phoneNumberId: "PHONE_A" }]);
    await bootstrapAccount(TEST_ACCOUNT_ID, "WABA_B", [{ phoneNumberId: "PHONE_B" }]);

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_A",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PHONE_A" },
                messages: [{ from: "34600000000", id: "wamid.A", timestamp: "1700000000", type: "text", text: { body: "A" } }],
              },
            },
          ],
        },
        {
          id: "WABA_B",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PHONE_B" },
                messages: [{ from: "34600000001", id: "wamid.B", timestamp: "1700000000", type: "text", text: { body: "B" } }],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, received: 2 });

    await runInDurableObject(getGatewayStubForWaba(env, "WABA_A"), async (instance: EccosGateway) => {
      expect(instance.getCounts().inbound).toBe(1);
    });
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_B"), async (instance: EccosGateway) => {
      expect(instance.getCounts().inbound).toBe(1);
    });
  });

  it("ignores webhook entries for inactive WABAs", async () => {
    await runInDurableObject(getControlPlaneStub(env), async (instance) => {
      await instance.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_PENDING",
        metaAccessToken: "pending-token",
        provisioningStatus: "pending",
        phones: [{ phoneNumberId: "PHONE_PENDING" }],
      });
    });

    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "WABA_PENDING",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "PHONE_PENDING" },
            messages: [{ from: "34600000000", id: "wamid.PENDING", timestamp: "1700000000", type: "text", text: { body: "ignored" } }],
          },
        }],
      }],
    };
    const body = JSON.stringify(payload);
    const res = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: 0 });
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_PENDING"), async (instance: EccosGateway) => {
      expect(instance.getCounts().inbound).toBe(0);
    });
  });

  it("ignores webhook entries for failed WABAs", async () => {
    await runInDurableObject(getControlPlaneStub(env), async (instance) => {
      await instance.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_FAILED",
        metaAccessToken: "failed-token",
        provisioningStatus: "failed",
        phones: [{ phoneNumberId: "PHONE_FAILED" }],
      });
    });

    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "WABA_FAILED",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "PHONE_FAILED" },
            messages: [{ from: "34600000000", id: "wamid.FAILED", timestamp: "1700000000", type: "text", text: { body: "ignored" } }],
          },
        }],
      }],
    };
    const body = JSON.stringify(payload);
    const res = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: 0 });
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_FAILED"), async (instance: EccosGateway) => {
      expect(instance.getCounts().inbound).toBe(0);
    });
  });

  it("POST /v1/wabas/WABA_TEST/messages requires auth and forwards to Meta", async () => {
    const unauthorized = await exports.default.fetch("http://example.com/v1/wabas/WABA_TEST/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "34600000000", type: "text", text: { body: "hi" } }),
    });
    expect(unauthorized.status).toBe(401);

    mockGraphFetch();

    const ok = await exports.default.fetch("http://example.com/v1/wabas/WABA_TEST/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: "34600000000", type: "text", text: { body: "hi" } }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, messages: [{ id: "wamid.TEST" }] });
  });

  it("does not expose unscoped stateful routes", async () => {
    const headers = { authorization: `Bearer ${API_KEY}` };
    const routes = [
      ["POST", "/v1/messages"],
      ["GET", "/v1/templates"],
      ["POST", "/v1/privacy/erasure"],
    ] as const;

    for (const [method, path] of routes) {
      const res = await exports.default.fetch(`http://example.com${path}`, { method, headers });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("POST /v1/wabas/WABA_TEST/messages returns 429 when the optional send rate limiter rejects", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    (env as { SEND_RATE_LIMITER?: RateLimit }).SEND_RATE_LIMITER = { limit };
    const graphFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unexpected", { status: 200 }));

    const res = await exports.default.fetch("http://example.com/v1/wabas/WABA_TEST/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: "34600000000", type: "text", text: { body: "hi" } }),
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "rate limited" });
    expect(limit).toHaveBeenCalledWith({ key: `${TEST_ACCOUNT_ID}:WABA_TEST` });
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("POST /v1/wabas/{pending|failed}/messages is fail-closed: 404 and Meta is never called", async () => {
    await runInDurableObject(getControlPlaneStub(env), async (instance) => {
      await instance.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_SEND_PENDING",
        metaAccessToken: "pending-token",
        provisioningStatus: "pending",
        phones: [{ phoneNumberId: "PNID_SEND_PENDING" }],
      });
      await instance.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_SEND_FAILED",
        metaAccessToken: "failed-token",
        provisioningStatus: "failed",
        phones: [{ phoneNumberId: "PNID_SEND_FAILED" }],
      });
    });
    // A mock that would happily answer any Meta Graph call — a fail-closed
    // gateway must never reach it for non-active WABAs.
    const graphFetch = mockGraphFetch();

    for (const wabaId of ["WABA_SEND_PENDING", "WABA_SEND_FAILED"]) {
      const res = await exports.default.fetch(`http://example.com/v1/wabas/${wabaId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ to: "34600000000", type: "text", text: { body: "hi" } }),
      });
      expect(res.status, wabaId).toBe(404);
      expect(await res.json(), wabaId).toEqual({ ok: false, error: "WABA is not configured" });
    }

    expect(graphFetch.mock.calls.some(([input]) => String(input).includes("/messages"))).toBe(false);
  });

  it("GET /v1/wabas/WABA_TEST/templates requires auth and returns Meta JSON", async () => {
    mockGraphFetch();

    const res = await exports.default.fetch("http://example.com/v1/wabas/WABA_TEST/templates", {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ name: "hello_world", language: "en_US", status: "APPROVED" }],
    });
  });

  it("smoke: webhook reply is forwarded to subscriber on alarm", async () => {
    const payload = metaEnvelope({
      messages: [
        {
          from: "34600000000",
          id: "wamid.SMOKE",
          timestamp: "1700000000",
          type: "text",
          text: { body: "Smoke test" },
        },
      ],
    });
    const body = JSON.stringify(payload);
    // The forwarding target is per-WABA DO config now (no env fallback).
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      instance.saveConfig({ SUBSCRIBER_WEBHOOK_URL: "https://subscriber.test/webhook" });
    });
    const fetchMock = mockGraphFetch();

    const webhookRes = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET),
      },
      body,
    });
    expect(webhookRes.status).toBe(200);

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      await instance.alarm();
    });

    const forwardCall = fetchMock.mock.calls.find(([, init]) => {
      const body = String(init?.body ?? "");
      return body.includes('"type":"reply"') && body.includes("wamid.SMOKE");
    });
    expect(forwardCall).toBeDefined();
    const forwardedBody = JSON.parse(String(forwardCall?.[1]?.body));
    expect(forwardedBody.events[0]).toMatchObject({
      type: "reply",
      messageId: "wamid.SMOKE",
      text: "Smoke test",
    });
  });

  it("ingests the same phone's webhook event only after the WABA becomes active", async () => {
    await runInDurableObject(getControlPlaneStub(env), async (instance) => {
      await instance.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_TRANSITION",
        metaAccessToken: "transition-token",
        callbackUrl: "https://gateway.example/webhooks/meta",
        provisioningStatus: "pending",
        phones: [{ phoneNumberId: "PHONE_TRANSITION" }],
      });
    });

    const webhookBody = (messageId: string) => {
      const payload = {
        object: "whatsapp_business_account",
        entry: [{
          id: "WABA_TRANSITION",
          changes: [{
            field: "messages",
            value: {
              metadata: { phone_number_id: "PHONE_TRANSITION" },
              messages: [{ from: "34600000000", id: messageId, timestamp: "1700000000", type: "text", text: { body: "hi" } }],
            },
          }],
        }],
      };
      return JSON.stringify(payload);
    };
    const postWebhook = async (body: string) =>
      exports.default.fetch("http://example.com/webhooks/meta", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
        body,
      });

    // While pending the event is ignored (fail closed)...
    const whilePending = await postWebhook(webhookBody("wamid.TRANSITION_BEFORE"));
    expect(whilePending.status).toBe(200);
    expect(await whilePending.json()).toEqual({ ok: true, received: 0 });
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_TRANSITION"), async (instance: EccosGateway) => {
      expect(instance.getCounts().inbound).toBe(0);
    });

    // ...then the WABA is provisioned (Meta mocked OK)...
    const fetchMock = mockGraphFetch();
    const provisioned = await provisionWaba(env, TEST_ACCOUNT_ID, "WABA_TRANSITION");
    expect(provisioned).toMatchObject({ attempted: true, error: null });
    await runInDurableObject(getControlPlaneStub(env), async (instance) => {
      expect((await instance.getWabaRecord(TEST_ACCOUNT_ID, "WABA_TRANSITION"))?.status).toBe("active");
    });

    // ...and the same phone's event is now ingested.
    const afterActive = await postWebhook(webhookBody("wamid.TRANSITION_AFTER"));
    expect(afterActive.status).toBe(200);
    expect(await afterActive.json()).toEqual({ ok: true, received: 1 });
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_TRANSITION"), async (instance: EccosGateway) => {
      expect(instance.getCounts().inbound).toBe(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the subscribed_apps provisioning call
  });
});
