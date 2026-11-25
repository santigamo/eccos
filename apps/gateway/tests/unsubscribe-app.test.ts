import { afterEach, expect, test } from "bun:test";
import { unsubscribeApp } from "../src/meta/connect-api";

const cfg = { META_GRAPH_VERSION: "v25.0", META_WEBHOOK_VERIFY_TOKEN: "verify" } as Parameters<typeof unsubscribeApp>[0];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("DELETEs the WABA's subscribed_apps with the WABA token", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json({ success: true });
  }) as typeof fetch;
  await unsubscribeApp(cfg, "W1", "tok");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toEndWith("/v25.0/W1/subscribed_apps");
  expect(calls[0]!.init?.method).toBe("DELETE");
  expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
});

test("a Graph error throws", async () => {
  globalThis.fetch = (async () => Response.json({ error: { code: 200 } }, { status: 403 })) as unknown as typeof fetch;
  await expect(unsubscribeApp(cfg, "W1", "tok")).rejects.toThrow(/subscribed_apps/);
});
