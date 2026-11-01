import { describe, expect, test } from "bun:test";

import { absolutizeUnfurlTags } from "../src/server/unfurl";

const html = (body: string, type = "text/html; charset=utf-8") =>
  new Response(body, { headers: { "content-type": type } });

describe("absolutizeUnfurlTags", () => {
  test("resolves relative og:url and og:image against the request origin", async () => {
    const res = absolutizeUnfurlTags(
      html('<meta property="og:url" content="/"><meta property="og:image" content="/assets/banner.jpg">'),
      "https://console.example.com",
    );
    const out = await res.text();
    expect(out).toContain('content="https://console.example.com/"');
    expect(out).toContain('content="https://console.example.com/assets/banner.jpg"');
  });

  test("leaves non-HTML responses untouched", async () => {
    const res = absolutizeUnfurlTags(html('{"content":"/"}', "application/json"), "https://x.example");
    expect(await res.text()).toBe('{"content":"/"}');
  });
});
