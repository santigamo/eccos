import { describe, expect, test } from "bun:test";
import {
  authErrorMessage,
  isDuplicateEmailError,
  safeRedirectTarget,
} from "../src/components/auth/auth-page";
import { redactError } from "../src/routes/signup";

describe("safeRedirectTarget", () => {
  test("accepts same-origin absolute paths, preserving query strings", () => {
    expect(safeRedirectTarget("/inbound?wabaId=abc")).toBe("/inbound?wabaId=abc");
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
