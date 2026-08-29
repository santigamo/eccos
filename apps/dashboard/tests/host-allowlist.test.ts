/**
 * Canonical-host allowlist tests (eccos-0x0.4, contract §6): the raw Workers
 * origin must not be an alternate customer path, and localhost is allowed only
 * in a development configuration.
 */

import { describe, expect, test } from "bun:test";

// The server entry imports TanStack Start + cloudflare:workers, which are not
// available under bun test. Test the allowlist logic through a tiny extracted
// mirror: keep this in sync with src/server.ts (single source there).
function makeAllowlist(configuredBaseURL: string | undefined) {
  const CANONICAL_HOSTS = new Set(["app.eccos.chat"]);
  const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
  return function isAllowedHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    if (CANONICAL_HOSTS.has(host)) return true;
    const configured = configuredBaseURL?.trim() || "";
    const isDevConfig = !configured.startsWith("https://");
    return isDevConfig && DEV_HOSTS.has(host);
  };
}

describe("canonical host allowlist", () => {
  test("accepts the canonical customer origin", () => {
    const isAllowed = makeAllowlist("https://app.eccos.chat");
    expect(isAllowed("app.eccos.chat")).toBe(true);
    expect(isAllowed("APP.ECCOS.CHAT.")).toBe(true);
  });

  test("rejects workers.dev and preview origins (fail closed)", () => {
    const isAllowed = makeAllowlist("https://app.eccos.chat");
    expect(isAllowed("eccos-dashboard.someaccount.workers.dev")).toBe(false);
    expect(isAllowed("preview-abc.example.preview.app")).toBe(false);
    expect(isAllowed("evil.eccos.chat")).toBe(false);
    expect(isAllowed("app.eccos.chat.evil.example")).toBe(false);
  });

  test("allows localhost only in a development configuration", () => {
    const dev = makeAllowlist("http://localhost:3000");
    const unset = makeAllowlist(undefined);
    expect(dev("localhost")).toBe(true);
    expect(dev("127.0.0.1")).toBe(true);
    expect(unset("localhost")).toBe(true);
    // A production (https) configuration must reject localhost too.
    const prod = makeAllowlist("https://app.eccos.chat");
    expect(prod("localhost")).toBe(false);
  });
});
