import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

type MutableEnv = Record<string, unknown>;

afterEach(async () => {
  await reset();
});

describe("GET /health", () => {
  it("stays a cheap liveness check unaffected by readiness concerns", async () => {
    const res = await exports.default.fetch("http://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "eccos", version: "0.1.0" });
  });
});

describe("GET /ready", () => {
  it("returns 200 with all checks passing when config and the Durable Object are healthy", async () => {
    const res = await exports.default.fetch("http://example.com/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      config: Record<string, boolean>;
      durableObject: { ok: boolean; error: string | null };
    };
    expect(body.ok).toBe(true);
    expect(body.durableObject).toEqual({ ok: true, error: null });
    expect(body.config).toEqual({
      META_ACCESS_TOKEN: true,
      META_PHONE_NUMBER_ID: true,
      META_WABA_ID: true,
      META_APP_SECRET: true,
      META_WEBHOOK_VERIFY_TOKEN: true,
      ECCOS_API_KEY: true,
    });
  });

  it("returns 503 and names the missing key (never its value) when a required secret is absent", async () => {
    const saved = env.ECCOS_API_KEY;
    delete (env as MutableEnv).ECCOS_API_KEY;
    try {
      const res = await exports.default.fetch("http://example.com/ready");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; config: Record<string, boolean> };
      expect(body.ok).toBe(false);
      expect(body.config.ECCOS_API_KEY).toBe(false);
      expect(JSON.stringify(body)).not.toContain(saved);
    } finally {
      (env as MutableEnv).ECCOS_API_KEY = saved;
    }
  });
});
