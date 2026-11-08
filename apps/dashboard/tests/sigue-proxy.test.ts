import { describe, expect, test } from "bun:test";
import { withSigueClientIp } from "../src/server/sigue-proxy";

const PROXY = "203.0.113.7";
const SECRET = "s3cret-value";
const env = { SIGUE_PROXY_IPS: `${PROXY}, 203.0.113.8`, SIGUE_PROXY_SECRET: SECRET };

function req(headers: Record<string, string>): Request {
  return new Request("https://app.example.test/api/auth/sign-in/email", { method: "POST", body: "{}", headers });
}

const fromProxy = (extra: Record<string, string> = {}) =>
  req({ "cf-connecting-ip": PROXY, "x-sigue-client-ip": "198.51.100.9", "x-sigue-proxy-auth": SECRET, ...extra });

describe("withSigueClientIp", () => {
  test("a request from the proxy with the secret takes the visitor IP", () => {
    const out = withSigueClientIp(fromProxy(), env);
    expect(out.headers.get("cf-connecting-ip")).toBe("198.51.100.9");
    expect(out.headers.has("x-sigue-client-ip")).toBe(false);
    expect(out.headers.has("x-sigue-proxy-auth")).toBe(false);
  });

  test("the body and method survive the rewrite", async () => {
    const out = withSigueClientIp(fromProxy(), env);
    expect(out.method).toBe("POST");
    expect(await out.text()).toBe("{}");
  });

  test("accepts an IPv6 visitor", () => {
    const out = withSigueClientIp(fromProxy({ "x-sigue-client-ip": "2001:db8::1" }), env);
    expect(out.headers.get("cf-connecting-ip")).toBe("2001:db8::1");
  });

  test("a wrong secret keeps the edge IP and strips the headers", () => {
    const out = withSigueClientIp(fromProxy({ "x-sigue-proxy-auth": "nope-nope-nop" }), env);
    expect(out.headers.get("cf-connecting-ip")).toBe(PROXY);
    expect(out.headers.has("x-sigue-client-ip")).toBe(false);
    expect(out.headers.has("x-sigue-proxy-auth")).toBe(false);
  });

  test("the right secret from any other peer is ignored", () => {
    const out = withSigueClientIp(fromProxy({ "cf-connecting-ip": "192.0.2.50" }), env);
    expect(out.headers.get("cf-connecting-ip")).toBe("192.0.2.50");
    expect(out.headers.has("x-sigue-proxy-auth")).toBe(false);
  });

  test("a visitor value that is not an IP is ignored", () => {
    const out = withSigueClientIp(fromProxy({ "x-sigue-client-ip": "evil, 1.1.1.1" }), env);
    expect(out.headers.get("cf-connecting-ip")).toBe(PROXY);
  });

  test.each([
    ["no secret", { SIGUE_PROXY_IPS: PROXY }],
    ["no proxy list", { SIGUE_PROXY_SECRET: SECRET }],
    ["empty env", {}],
  ])("feature off (%s): the claim is ignored and stripped", (_name, off) => {
    const out = withSigueClientIp(fromProxy(), off);
    expect(out.headers.get("cf-connecting-ip")).toBe(PROXY);
    expect(out.headers.has("x-sigue-client-ip")).toBe(false);
  });

  test("a request without x-sigue headers is returned untouched", () => {
    const input = req({ "cf-connecting-ip": "192.0.2.50" });
    expect(withSigueClientIp(input, env)).toBe(input);
  });
});
