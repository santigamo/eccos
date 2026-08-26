import { env, exports } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { metaEnvelope, gatewayStub } from "./helpers";

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
    if (url === env.SUBSCRIBER_WEBHOOK_URL || String(init?.method ?? "GET").toUpperCase() === "POST") {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

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
        authorization: `Bearer ${env.ECCOS_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: "34600000000", type: "text", text: { body: "hi" } }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, messages: [{ id: "wamid.TEST" }] });
  });

  it("does not expose unscoped legacy stateful routes", async () => {
    const headers = { authorization: `Bearer ${env.ECCOS_API_KEY}` };
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
        authorization: `Bearer ${env.ECCOS_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: "34600000000", type: "text", text: { body: "hi" } }),
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "rate limited" });
    expect(limit).toHaveBeenCalledWith({ key: `${env.ECCOS_API_KEY}:WABA_TEST` });
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("GET /v1/wabas/WABA_TEST/templates requires auth and returns Meta JSON", async () => {
    mockGraphFetch();

    const res = await exports.default.fetch("http://example.com/v1/wabas/WABA_TEST/templates", {
      headers: { authorization: `Bearer ${env.ECCOS_API_KEY}` },
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
});
