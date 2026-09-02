import { describe, expect, test } from "bun:test";
import * as validation from "../src/components/blocks/auth-13/components/validation";
import {
  validateEmail,
  validateName,
  validatePassword,
  validateWorkspaceName,
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

describe("there is no workspace-slug validator", () => {
  test("the module exports nothing slug-shaped", () => {
    // The slug stopped being a form field: it is minted server-side as an
    // opaque UUID (src/organizations.ts), so a validator for a value the user
    // can no longer type is a validator for a field that must not come back.
    expect(Object.keys(validation).some((key) => /slug/i.test(key))).toBe(false);
  });
});
