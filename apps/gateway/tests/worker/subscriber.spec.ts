import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { singletonStub } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function makeRpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

describe("subscriber config (feature A)", () => {
  it("round-trips url + secret but NEVER exposes the secret value", async () => {
    const rpc = makeRpc();
    const secret = "s3cr3t-rotation-value";

    expect(await rpc.setSubscriberConfig({ url: "https://new.example/hook", secret })).toEqual({
      ok: true,
    });

    const cfg = await rpc.getSubscriberConfig();
    expect(cfg).toEqual({ url: "https://new.example/hook", hasSecret: true });
    // The secret must not leak through the read model in any shape.
    expect(JSON.stringify(cfg)).not.toContain(secret);
    expect(Object.values(cfg)).not.toContain(secret);

    // ...but it was persisted internally so forwardOne can sign with it.
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      expect(i.getConfigValue("SUBSCRIBER_SECRET")).toBe(secret);
    });
  });

  it("setSubscriberConfig without a secret keeps the existing one (url-only rotation)", async () => {
    const rpc = makeRpc();
    await rpc.setSubscriberConfig({ url: "https://first.example/hook", secret: "keep-me" });
    await rpc.setSubscriberConfig({ url: "https://second.example/hook" });

    const cfg = await rpc.getSubscriberConfig();
    expect(cfg).toEqual({ url: "https://second.example/hook", hasSecret: true });
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      expect(i.getConfigValue("SUBSCRIBER_SECRET")).toBe("keep-me");
    });
  });

  it("falls back to env when no DO config is set", async () => {
    const cfg = await makeRpc().getSubscriberConfig();
    expect(cfg).toEqual({ url: env.SUBSCRIBER_WEBHOOK_URL, hasSecret: true });
  });

  it("forwardOne prefers the DO config override URL + secret over env", async () => {
    const overrideUrl = "https://override.example/hook";
    const overrideSecret = "override-secret";
    await makeRpc().setSubscriberConfig({ url: overrideUrl, secret: overrideSecret });

    const event: WhatsAppCallbackEvent = {
      type: "reply",
      from: "34600000000",
      messageId: "wamid.OVERRIDE",
      text: "hola",
      at: 1_700_000_000_000,
    };
    await singletonStub().ingest([event]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      await i.alarm();
    });

    // Forwarded to the config URL, never to the env URL.
    const overrideCall = fetchMock.mock.calls.find(([u]) => String(u) === overrideUrl);
    expect(overrideCall).toBeDefined();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === env.SUBSCRIBER_WEBHOOK_URL)).toBe(false);

    // Signed with the override secret, not the env secret.
    const body = String(overrideCall?.[1]?.body ?? "");
    const headers = new Headers(overrideCall?.[1]?.headers);
    expect(headers.get("x-eccos-signature")).toBe(await signPayload(body, overrideSecret));
    expect(headers.get("x-eccos-signature")).not.toBe(await signPayload(body, env.SUBSCRIBER_SECRET));
  });
});

describe("resubscribe (feature B)", () => {
  function mockSubscribedApps(status: number) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/subscribed_apps")) {
        return new Response(JSON.stringify(status < 300 ? { success: true } : { error: { message: "nope" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
  }

  async function setCallbackUrl(url: string) {
    await runInDurableObject(singletonStub(), async (i: EccosGateway) => {
      i.saveConfig({ META_WEBHOOK_CALLBACK_URL: url });
    });
  }

  it("calls Meta subscribed_apps and returns { ok: true } on success", async () => {
    await setCallbackUrl("https://worker.test/webhooks/meta");
    const fetchMock = mockSubscribedApps(200);

    const res = await makeRpc().resubscribe();

    expect(res).toEqual({ ok: true });
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/subscribed_apps"));
    expect(call).toBeDefined();
    // Uses the WABA id + persisted access token.
    expect(String(call?.[0])).toContain(`/${env.META_WABA_ID}/subscribed_apps`);
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(`Bearer ${env.META_ACCESS_TOKEN}`);
  });

  it("returns { ok: false } when Meta rejects the subscription", async () => {
    await setCallbackUrl("https://worker.test/webhooks/meta");
    mockSubscribedApps(400);

    const res = await makeRpc().resubscribe();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("subscribed_apps");
  });

  it("returns { ok: false } without calling Meta when no callback URL is configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    const res = await makeRpc().resubscribe();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("META_WEBHOOK_CALLBACK_URL");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/subscribed_apps"))).toBe(false);
  });
});
