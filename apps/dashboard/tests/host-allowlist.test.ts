/**
 * Canonical-host allowlist tests (eccos-0x0.4, contract §6): the raw Workers
 * origin must not be an alternate customer path, the allowed host comes from
 * BETTER_AUTH_URL, and localhost is allowed only in a development configuration.
 */

import { describe, expect, test } from "bun:test";

import { isAllowedHost } from "../src/auth/config";

const makeAllowlist = (configuredBaseURL: string | undefined) => (hostname: string) =>
  isAllowedHost(hostname, configuredBaseURL);

describe("canonical host allowlist", () => {
  test("accepts the canonical customer origin", () => {
    const isAllowed = makeAllowlist("https://app.eccos.chat");
    expect(isAllowed("app.eccos.chat")).toBe(true);
    expect(isAllowed("APP.ECCOS.CHAT.")).toBe(true);
  });

  test("follows BETTER_AUTH_URL, so a self-hosted console works on its own domain", () => {
    const isAllowed = makeAllowlist("https://console.example.com");
    expect(isAllowed("console.example.com")).toBe(true);
    expect(isAllowed("app.eccos.chat")).toBe(false);
  });

  test("rejects public hosts when BETTER_AUTH_URL is unset (fail closed)", () => {
    expect(makeAllowlist(undefined)("app.eccos.chat")).toBe(false);
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
