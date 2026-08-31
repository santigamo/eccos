import { describe, expect, test } from "bun:test";
import {
  validateEmail,
  validateName,
  validatePassword,
  validateWorkspaceName,
  validateWorkspaceSlug,
} from "../src/components/blocks/auth-13/components/validation";

describe("validateEmail", () => {
  test("rejects empty and whitespace-only values", () => {
    expect(validateEmail("")).toBe("Enter your email");
    expect(validateEmail("   ")).toBe("Enter your email");
  });

  test("rejects malformed addresses", () => {
    expect(validateEmail("not-an-email")).toBe("Enter a valid email address");
    expect(validateEmail("a@b")).toBe("Enter a valid email address");
  });

  test("accepts real addresses", () => {
    expect(validateEmail("ops@physeo.com")).toBeNull();
    expect(validateEmail("  ops@physeo.com  ")).toBeNull();
  });
});

describe("validatePassword", () => {
  test("rejects empty", () => {
    expect(validatePassword("")).toBe("Enter your password");
  });

  test("enforces the 10-character floor", () => {
    expect(validatePassword("123456789")).toBe("Password must be at least 10 characters");
    expect(validatePassword("1234567890")).toBeNull();
  });
});

describe("validateName / validateWorkspaceName", () => {
  test("rejects empty and whitespace-only names", () => {
    expect(validateName("")).toBe("Enter your name");
    expect(validateName("   ")).toBe("Enter your name");
    expect(validateWorkspaceName("")).toBe("Enter a workspace name");
    expect(validateWorkspaceName("Physeo")).toBeNull();
  });
});

describe("validateWorkspaceSlug", () => {
  test("rejects empty", () => {
    expect(validateWorkspaceSlug("")).toBe("Choose a workspace URL");
  });

  test("rejects characters outside a-z0-9-", () => {
    expect(validateWorkspaceSlug("Physeo")).toBe("Lowercase letters, numbers, and dashes only");
    expect(validateWorkspaceSlug("physeo_clinica")).toBe("Lowercase letters, numbers, and dashes only");
    expect(validateWorkspaceSlug("physeo clinica")).toBe("Lowercase letters, numbers, and dashes only");
  });

  test("enforces the 48-character cap", () => {
    expect(validateWorkspaceSlug("x".repeat(48))).toBeNull();
    expect(validateWorkspaceSlug("x".repeat(49))).toBe("Must be 48 characters or fewer");
  });

  test("accepts a valid slug", () => {
    expect(validateWorkspaceSlug("physeo-clinica")).toBeNull();
  });
});
