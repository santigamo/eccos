import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The composer's free-text send, as the console validates it before the gateway
 * ever sees it (`validateSendTextInput` in `src/server/gateway.ts`), and the copy
 * for a refused one (`sendTextFailureCopy` in `src/lib/failure.ts`).
 *
 * Fixtures use reserved fake numbers only.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { validateSendTextInput } = await import("../src/server/gateway");
const { sendTextFailureCopy } = await import("../src/lib/failure");

const valid = {
  wabaId: "waba-a",
  phoneNumberId: "phone-a",
  to: "34600111222",
  text: "Hola",
};

describe("validateSendTextInput", () => {
  test("passes a well-formed reply through, unchanged", () => {
    expect(validateSendTextInput(valid)).toEqual(valid);
  });

  test("passes a BSUID recipient through verbatim, for the gateway to address", () => {
    const bsuid = { ...valid, to: "US.13491208655302741918" };
    expect(validateSendTextInput(bsuid)).toEqual(bsuid);
    expect(validateSendTextInput({ ...valid, to: " CC.ENT.a1B2c3 " }).to).toBe("CC.ENT.a1B2c3");
  });

  test("normalizes the recipient the way the template sheet does, and trims the body", () => {
    expect(validateSendTextInput({ ...valid, to: "+34 600-111 222", text: "  Hola  " })).toEqual({
      ...valid,
      to: "34600111222",
      text: "Hola",
    });
  });

  test("refuses a body that is only whitespace, because it is not a message", () => {
    expect(() => validateSendTextInput({ ...valid, text: "   \n\t " })).toThrow(/message text is required/);
    expect(() => validateSendTextInput({ ...valid, text: "" })).toThrow(/message text is required/);
  });

  test("accepts a body of exactly Meta's 4096 characters and refuses one more", () => {
    expect(validateSendTextInput({ ...valid, text: "x".repeat(4096) }).text).toHaveLength(4096);
    expect(() => validateSendTextInput({ ...valid, text: "x".repeat(4097) })).toThrow(/too long/);
  });

  test("refuses a recipient that is not a phone number", () => {
    expect(() => validateSendTextInput({ ...valid, to: "not-a-number" })).toThrow(/international format/);
    expect(() => validateSendTextInput({ ...valid, to: "us.1349" })).toThrow(/international format/);
    expect(() => validateSendTextInput({ ...valid, to: 34600111222 })).toThrow(/recipient is required/);
  });

  test("refuses a missing WABA or sending number, and a body that is not text", () => {
    expect(() => validateSendTextInput({ ...valid, wabaId: undefined })).toThrow(/wabaId is required/);
    expect(() => validateSendTextInput({ ...valid, phoneNumberId: "" })).toThrow(/phoneNumberId is required/);
    expect(() => validateSendTextInput({ ...valid, text: 42 })).toThrow(/message text is required/);
  });
});

describe("sendTextFailureCopy", () => {
  test("a closed window says what to do instead, in the console's words", () => {
    const copy = sendTextFailureCopy("window_closed", "Meta's sentence");
    expect(copy.title).toBe("Outside the 24-hour window");
    expect(copy.detail).toContain("Send an approved template");
  });

  test("every other code reads as the template send reads it", () => {
    expect(sendTextFailureCopy("rate_limited", null).title).toBe("Send limit reached");
    expect(sendTextFailureCopy("no_phone", "x").title).toBe("Number no longer available");
    expect(sendTextFailureCopy("recipient_not_allowlisted", null).title).toBe("Recipient not allowed");
    expect(sendTextFailureCopy("graph", "Meta says no").detail).toBe("Meta says no");
  });

  test("no copy uses an em dash or an en dash", () => {
    for (const code of ["window_closed", "rate_limited", "no_phone", "recipient_not_allowlisted", "graph"] as const) {
      const copy = sendTextFailureCopy(code, null);
      expect(`${copy.title} ${copy.detail}`, code).not.toMatch(/[—–]/);
    }
  });
});
