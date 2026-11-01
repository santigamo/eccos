import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  authErrorMessage,
  isDuplicateEmailError,
  redactError,
} from "../src/components/auth/auth-page";
import {
  REDIRECTABLE_PAGES,
  safeRedirectTarget,
  signInHref,
} from "../src/auth/redirect-target";

describe("safeRedirectTarget", () => {
  test("accepts same-origin absolute paths, preserving query strings", () => {
    expect(safeRedirectTarget("/events?wabaId=abc")).toBe("/events?wabaId=abc");
    expect(safeRedirectTarget("/")).toBe("/");
    expect(safeRedirectTarget("/deliveries")).toBe("/deliveries");
  });

  test("rejects protocol-relative and backslash open-redirect vectors", () => {
    expect(safeRedirectTarget("//evil.example")).toBeUndefined();
    expect(safeRedirectTarget("/\\evil.example")).toBeUndefined();
    expect(safeRedirectTarget("\\\\evil.example")).toBeUndefined();
  });

  test("rejects non-path values and control characters", () => {
    expect(safeRedirectTarget("https://evil.example")).toBeUndefined();
    expect(safeRedirectTarget("javascript:alert(1)")).toBeUndefined();
    expect(safeRedirectTarget(undefined)).toBeUndefined();
    expect(safeRedirectTarget("")).toBeUndefined();
    expect(safeRedirectTarget("/a\u0000b")).toBeUndefined();
    expect(safeRedirectTarget("/a\nb")).toBeUndefined();
  });

  test("rejects server functions, API paths, static files and unknown paths", () => {
    expect(safeRedirectTarget("/_serverFn/abc123?payload=%7B%7D")).toBeUndefined();
    expect(safeRedirectTarget("/api/auth/get-session")).toBeUndefined();
    expect(safeRedirectTarget("/assets/index-abc.js")).toBeUndefined();
    expect(safeRedirectTarget("/robots.txt")).toBeUndefined();
    expect(safeRedirectTarget("/favicon.ico")).toBeUndefined();
    expect(safeRedirectTarget("/numbers/../_serverFn/x")).toBeUndefined();
    expect(safeRedirectTarget("/signin")).toBeUndefined();
  });

  test("accepts every app page, with query and hash", () => {
    expect(safeRedirectTarget("/numbers/attach-token?wabaId=1")).toBe("/numbers/attach-token?wabaId=1");
    expect(safeRedirectTarget("/invitations?id=abc")).toBe("/invitations?id=abc");
    expect(safeRedirectTarget("/templates#top")).toBe("/templates#top");
  });

  test("covers exactly the route tree's pages minus the public auth pages", () => {
    const tree = readFileSync(new URL("../src/routeTree.gen.ts", import.meta.url), "utf8");
    const union = tree.match(/fullPaths:([\s\S]*?)\n\s+fileRoutesByTo/)?.[1] ?? "";
    const routes = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const auth = new Set(["/signin", "/signup", "/forgot-password", "/reset-password"]);
    expect(routes.length).toBeGreaterThan(0);
    expect([...REDIRECTABLE_PAGES].sort()).toEqual(routes.filter((r) => !auth.has(r)).sort());
  });
});

describe("signInHref", () => {
  test("carries a safe page and drops anything else", () => {
    expect(signInHref("/events?wabaId=abc")).toBe("/signin?redirect=%2Fevents%3FwabaId%3Dabc");
    expect(signInHref("/_serverFn/abc?payload=x")).toBe("/signin");
    expect(signInHref("/robots.txt")).toBe("/signin");
    expect(signInHref(undefined)).toBe("/signin");
  });
});

describe("authErrorMessage", () => {
  test("maps EMAIL_NOT_VERIFIED to the verification notice", () => {
    expect(
      authErrorMessage({ status: 403, code: "EMAIL_NOT_VERIFIED", message: "raw" }, "fb"),
    ).toBe("Verify your email address first, then sign in again.");
  });

  test("falls back instead of leaking raw server text for unknown errors", () => {
    expect(
      authErrorMessage({ status: 400, code: "SOMETHING_ODD", message: "x".repeat(500) }, "fb"),
    ).toBe("fb");
  });

  test("renders bounded messages for ordinary failures", () => {
    expect(
      authErrorMessage({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, "fb"),
    ).toBe("Invalid email or password");
  });
});

describe("isDuplicateEmailError", () => {
  test("detects USER_ALREADY_EXISTS code and 422 status", () => {
    expect(isDuplicateEmailError({ code: "USER_ALREADY_EXISTS" })).toBe(true);
    expect(isDuplicateEmailError({ status: 422 })).toBe(true);
    expect(isDuplicateEmailError({ code: "FAILED" })).toBe(false);
    expect(isDuplicateEmailError(null)).toBe(false);
  });
});

describe("redactError (signup ?error= param)", () => {
  test("passes through bounded messages and drops oversized ones", () => {
    expect(redactError("Session expired")).toBe("Session expired");
    expect(redactError("x".repeat(500))).toBeUndefined();
    expect(redactError("")).toBeUndefined();
  });
});
