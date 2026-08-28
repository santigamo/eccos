import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { EccosGateway } from "../../src/gateway";
import { validateSubscriberUrl } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { bootstrapAccount, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

beforeEach(async () => {
  await bootstrapAccount();
});

function makeRpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

describe("subscriber config (feature A)", () => {
  it("rejects insecure and private subscriber URLs", async () => {
    for (const url of [
      "http://subscriber.example/hook",
      "ftp://subscriber.example/hook",
      "https://127.0.0.1/hook",
      "https://127.0.0.010/hook",
      "https://2130706433/hook",
      "https://[::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[fc00::1]/hook",
      "https://[fe80::1]/hook",
      "https://192.0.0.1/hook",
      "https://198.18.0.1/hook",
      "https://224.0.0.1/hook",
      "https://user:password@subscriber.example/hook",
    ]) {
      expect(() => validateSubscriberUrl(url)).toThrow(/invalid subscriber URL/);
    }
    await expect(
      makeRpc().setSubscriberConfig({ url: "https://subscriber.example/hook", secret: "s" }, TEST_WABA_ID, TEST_ACCOUNT_ID),
    ).resolves.toEqual({ ok: true });
  });

  it("does not misclassify ordinary DNS names that start like IPv6 prefixes", async () => {
    await expect(
      makeRpc().setSubscriberConfig({ url: "https://fc.example/hook" }, TEST_WABA_ID, TEST_ACCOUNT_ID),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects redirects instead of following a subscriber location", async () => {
    await makeRpc().setSubscriberConfig({ url: "https://subscriber.example/hook" }, TEST_WABA_ID, TEST_ACCOUNT_ID);
    await gatewayStub().ingest([
      {
        type: "reply",
        from: "34600000000",
        messageId: "wamid.REDIRECT",
        text: "hello",
        at: 1_700_000_000_000,
      },
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("redirect", { status: 302, headers: { location: "http://127.0.0.1/hook" } }),
    );
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      await i.alarm();
      const call = fetchMock.mock.calls.find(([url]) => String(url) === "https://subscriber.example/hook");
      expect(call?.[1]?.redirect).toBe("error");
      expect(i.getDelivery(1)).toMatchObject({ status: "pending", last_error: "subscriber returned 302" });
    });
  });

  it("round-trips url + secret but NEVER exposes the secret value", async () => {
    const rpc = makeRpc();
    const secret = "s3cr3t-rotation-value";

    expect(await rpc.setSubscriberConfig({ url: "https://new.example/hook", secret }, TEST_WABA_ID, TEST_ACCOUNT_ID)).toEqual({
      ok: true,
    });

    const cfg = await rpc.getSubscriberConfig(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(cfg).toEqual({ url: "https://new.example/hook", hasSecret: true });
    // The secret must not leak through the read model in any shape.
    expect(JSON.stringify(cfg)).not.toContain(secret);
    expect(Object.values(cfg)).not.toContain(secret);

    // ...but it was persisted internally so forwardOne can sign with it.
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      expect(i.getConfigValue("SUBSCRIBER_SECRET")).toBe(secret);
    });
  });

  it("setSubscriberConfig without a secret keeps the existing one (url-only rotation)", async () => {
    const rpc = makeRpc();
    await rpc.setSubscriberConfig({ url: "https://first.example/hook", secret: "keep-me" }, TEST_WABA_ID, TEST_ACCOUNT_ID);
    await rpc.setSubscriberConfig({ url: "https://second.example/hook" }, TEST_WABA_ID, TEST_ACCOUNT_ID);

    const cfg = await rpc.getSubscriberConfig(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(cfg).toEqual({ url: "https://second.example/hook", hasSecret: true });
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      expect(i.getConfigValue("SUBSCRIBER_SECRET")).toBe("keep-me");
    });
  });

  it("reports an unset forwarding target when no DO config exists (no env fallback)", async () => {
    const cfg = await makeRpc().getSubscriberConfig(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(cfg).toEqual({ url: null, hasSecret: false });
  });

  it("forwardOne uses the DO config override URL + secret", async () => {
    const overrideUrl = "https://override.example/hook";
    const overrideSecret = "override-secret";
    await makeRpc().setSubscriberConfig({ url: overrideUrl, secret: overrideSecret }, TEST_WABA_ID, TEST_ACCOUNT_ID);

    const event: WhatsAppCallbackEvent = {
      type: "reply",
      from: "34600000000",
      messageId: "wamid.OVERRIDE",
      text: "hola",
      at: 1_700_000_000_000,
    };
    await gatewayStub().ingest([event]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      await i.alarm();
    });

    // Forwarded to the config URL.
    const overrideCall = fetchMock.mock.calls.find(([u]) => String(u) === overrideUrl);
    expect(overrideCall).toBeDefined();

    // Signed with the override secret.
    const body = String(overrideCall?.[1]?.body ?? "");
    const headers = new Headers(overrideCall?.[1]?.headers);
    expect(headers.get("x-eccos-signature")).toBe(await signPayload(body, overrideSecret));
    expect(headers.get("x-eccos-signature")).not.toBe(await signPayload(body, "unrelated-secret"));
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
    await runInDurableObject(getControlPlaneStub(env), async (i) => {
      i.sql.exec("UPDATE wabas SET callback_url = ? WHERE waba_id = ?", url, TEST_WABA_ID);
    });
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      i.saveConfig({ META_WEBHOOK_CALLBACK_URL: "https://stale.example/webhooks/meta" });
    });
  }

  it("calls Meta subscribed_apps and returns { ok: true } on success", async () => {
    await setCallbackUrl("https://worker.test/webhooks/meta");
    const fetchMock = mockSubscribedApps(200);

    const res = await makeRpc().resubscribe(TEST_WABA_ID, TEST_ACCOUNT_ID);

    expect(res).toEqual({ ok: true });
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/subscribed_apps"));
    expect(call).toBeDefined();
  });

  it("returns { ok: false } when Meta rejects the subscription", async () => {
    await setCallbackUrl("https://worker.test/webhooks/meta");
    mockSubscribedApps(400);

    const res = await makeRpc().resubscribe(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("subscribed_apps");
  });

  it("returns { ok: false } without calling Meta when no callback URL is configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    const res = await makeRpc().resubscribe(TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("META_WEBHOOK_CALLBACK_URL");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/subscribed_apps"))).toBe(false);
  });
});
