/**
 * Resend mail adapter tests (eccos-0x0.11): env handling and fail-closed
 * delivery error surfacing.
 */

import { afterEach, describe, expect, test, vi } from "bun:test";

describe("ResendMailSender", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("throws when RESEND_API_KEY is missing (fail closed)", async () => {
    const { ResendMailSender } = await import("../src/auth/mail-resend");
    expect(() => new ResendMailSender({})).toThrow(/RESEND_API_KEY/);
  });

  test("uses the development sender when no API key is configured", async () => {
    const { createMailSenderFromEnv } = await import("../src/auth/config");
    const { CaptureMailSender } = await import("../src/auth/mail");
    // No RESEND_API_KEY → ConsoleMailSender (dev). Assert via constructor name.
    const sender = createMailSenderFromEnv({}) as unknown as { constructor: { name: string } };
    expect(sender.constructor.name).toBe("ConsoleMailSender");
    expect(sender instanceof CaptureMailSender).toBe(false);
  });

  test("selects the Resend sender when RESEND_API_KEY is set", async () => {
    const { createMailSenderFromEnv } = await import("../src/auth/config");
    const { ResendMailSender } = await import("../src/auth/mail-resend");
    const sender = createMailSenderFromEnv({ RESEND_API_KEY: "re_test_key_123" });
    expect(sender instanceof ResendMailSender).toBe(true);
  });

  test("surfaces provider errors as thrown delivery failures", async () => {
    vi.mock("resend", () => {
      class Resend {
        emails = {
          send: async () => ({
            data: null,
            error: { name: "validation_error", message: "domain not verified" },
          }),
        };
      }
      return { Resend };
    });
    const { ResendMailSender } = await import("../src/auth/mail-resend");
    const sender = new ResendMailSender({ RESEND_API_KEY: "re_test_key_123" });
    await expect(
      sender.sendMail({ to: "user@example.com", subject: "s", text: "t" }),
    ).rejects.toThrow(/mail delivery failed/);
  });

  test("sends without error on provider success", async () => {
    vi.mock("resend", () => {
      class Resend {
        emails = {
          send: async () => ({ data: { id: "email-1" }, error: null }),
        };
      }
      return { Resend };
    });
    const { ResendMailSender } = await import("../src/auth/mail-resend");
    const sender = new ResendMailSender({ RESEND_API_KEY: "re_test_key_123" });
    await expect(
      sender.sendMail({ to: "user@example.com", subject: "s", text: "t" }),
    ).resolves.toBeUndefined();
  });
});
