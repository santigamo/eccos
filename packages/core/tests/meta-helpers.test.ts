import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sendMessage } from "@eccos/core/send";
import { listTemplates } from "@eccos/core/templates";
import type { CoreConfig, MetaAppConfig } from "@eccos/core/config-schema";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(): { requests: { url: string; init?: RequestInit }[] } {
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { requests };
}

describe("meta helpers narrow config to MetaAppConfig", () => {
  it("sendMessage accepts a full CoreConfig and reads only Meta fields", async () => {
    const cfg: CoreConfig = {
      META_GRAPH_VERSION: "v24.0",
      META_ACCESS_TOKEN: "token",
      META_PHONE_NUMBER_ID: "phone",
      META_WABA_ID: "waba",
      META_APP_SECRET: "secret",
      META_WEBHOOK_VERIFY_TOKEN: "verify",
      ECCOS_API_KEY: "api-key",
    };
    const { requests } = stubFetch();
    const result = await sendMessage(cfg, { to: "12345" });
    expect(result).toEqual({ ok: true, id: "wamid.test" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://graph.facebook.com/v24.0/phone/messages");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer token" });
  });

  it("sendMessage defaults the graph version when absent", async () => {
    const cfg: MetaAppConfig = { META_ACCESS_TOKEN: "token", META_PHONE_NUMBER_ID: "phone" };
    const { requests } = stubFetch();
    await sendMessage(cfg, { to: "12345" });
    expect(requests[0]?.url).toBe("https://graph.facebook.com/v24.0/phone/messages");
  });

  it("sendMessage resolves a per-request phone number id", async () => {
    const cfg: MetaAppConfig = { META_GRAPH_VERSION: "v21.0", META_ACCESS_TOKEN: "token", META_PHONE_NUMBER_ID: "tenant-phone" };
    const { requests } = stubFetch();
    await sendMessage(cfg, { to: "12345" });
    expect(requests[0]?.url).toBe("https://graph.facebook.com/v21.0/tenant-phone/messages");
  });

  it("sendMessage fails cleanly without calling fetch when phone is missing", async () => {
    const cfg: MetaAppConfig = { META_ACCESS_TOKEN: "token" };
    const { requests } = stubFetch();
    const result = await sendMessage(cfg, { to: "12345" });
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(String(result.error)).toContain("META_PHONE_NUMBER_ID is not configured");
    expect(requests).toHaveLength(0);
  });

  it("listTemplates accepts a full CoreConfig and reads only Meta fields", async () => {
    const cfg: CoreConfig = {
      META_GRAPH_VERSION: "v24.0",
      META_ACCESS_TOKEN: "token",
      META_PHONE_NUMBER_ID: "phone",
      META_WABA_ID: "waba",
      META_APP_SECRET: "secret",
      META_WEBHOOK_VERIFY_TOKEN: "verify",
      ECCOS_API_KEY: "api-key",
    };
    const { requests } = stubFetch();
    const result = await listTemplates(cfg, 50);
    expect(result).toEqual({ ok: true, data: { messages: [{ id: "wamid.test" }] } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://graph.facebook.com/v24.0/waba/message_templates?limit=50");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer token" });
  });

  it("listTemplates resolves a per-request default waba id", async () => {
    const cfg: MetaAppConfig = { META_ACCESS_TOKEN: "token", META_WABA_ID: "tenant-waba" };
    const { requests } = stubFetch();
    await listTemplates(cfg);
    expect(requests[0]?.url).toBe("https://graph.facebook.com/v24.0/tenant-waba/message_templates?limit=100");
  });

  it("listTemplates fails cleanly without calling fetch when waba id is missing", async () => {
    const cfg: MetaAppConfig = { META_ACCESS_TOKEN: "token" };
    const { requests } = stubFetch();
    const result = await listTemplates(cfg);
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(String(result.error)).toContain("META_WABA_ID is not configured");
    expect(requests).toHaveLength(0);
  });
});
