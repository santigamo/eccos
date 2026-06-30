import { env, exports } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EccosGateway } from "../../src/gateway";
import { singletonStub } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("POST /connect/exchange", () => {
  it("persists phone_number_id after Meta exchange", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "biz-token" }), { status: 200 });
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

    const res = await exports.default.fetch("http://example.com/connect/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", waba_id: "WABA123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      waba_id: "WABA123",
      phone_number_id: "PNID",
    });

    await runInDurableObject(singletonStub(), async (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBe("PNID");
      expect(instance.getConfigValue("META_WABA_ID")).toBe("WABA123");
      expect(instance.getConfigValue("DISPLAY_PHONE_NUMBER")).toBe("+34 600 000 000");
    });
  });
});
