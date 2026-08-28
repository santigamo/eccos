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
  it("returns 200 with all checks passing when app config and the control plane are healthy", async () => {
    const res = await exports.default.fetch("http://example.com/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      config: Record<string, boolean>;
      durableObject: { ok: boolean; error: string | null };
    };
    expect(body.ok).toBe(true);
    expect(body.durableObject).toEqual({ ok: true, error: null });
    // Only the app-level Meta platform secrets are required (no per-WABA globals).
    expect(body.config).toEqual({
      META_APP_SECRET: true,
      META_WEBHOOK_VERIFY_TOKEN: true,
    });
  });

  it("returns 503 and names the missing key (never its value) when a required app secret is absent", async () => {
    const saved = env.META_APP_SECRET;
    delete (env as MutableEnv).META_APP_SECRET;
    try {
      const res = await exports.default.fetch("http://example.com/ready");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; config: Record<string, boolean> };
      expect(body.ok).toBe(false);
      expect(body.config.META_APP_SECRET).toBe(false);
      expect(JSON.stringify(body)).not.toContain(saved);
    } finally {
      (env as MutableEnv).META_APP_SECRET = saved;
    }
  });

  it("stays healthy when the account registry is empty — readiness reports config, not tenants", async () => {
    const res = await exports.default.fetch("http://example.com/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; config: Record<string, boolean> };
    expect(body.ok).toBe(true);
    expect(body.config.META_APP_SECRET).toBe(true);
  });
});