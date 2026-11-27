import { describe, expect, test } from "bun:test";
import { countryOf, countryOptions, phoneProblemDetail, readPhone } from "../src/lib/phone-number";

describe("readPhone", () => {
  test("a number with its code is international, whatever its punctuation", () => {
    for (const raw of ["+34 600 111 222", "0034 600-111-222", "+34 (600) 111.222"]) {
      expect(readPhone(raw, "ES")).toMatchObject({ ok: true, digits: "34600111222", national: false });
    }
    expect(readPhone("+1 (415) 555-0100", "ES")).toMatchObject({ ok: true, digits: "14155550100" });
  });

  test("a national number takes the chosen country, and says so", () => {
    expect(readPhone("600 111 222", "ES")).toEqual({
      ok: true,
      digits: "34600111222",
      display: "+34 600 11 12 22",
      national: true,
      decimals: false,
    });
    expect(readPhone("(415) 555-0100", "US")).toMatchObject({ digits: "14155550100", national: true });
  });

  test("without a +, only a valid number of the chosen country: never read as another country's", () => {
    // Not Spanish, and it must not become +61 (Australia) by guessing the + it lacks.
    expect(readPhone("6123456789", "ES")).toEqual({ ok: false, reason: "no_code" });
    expect(readPhone("4155550100", "ES")).toEqual({ ok: false, reason: "no_code" });
    // Written with Spain's own code but no +: still Spanish, and nothing was added.
    expect(readPhone("34600111222", "ES")).toMatchObject({ ok: true, digits: "34600111222", national: false });
    expect(readPhone("600111222", null)).toEqual({ ok: false, reason: "no_code" });
  });

  test("a spreadsheet's trailing .00 is dropped and said, never folded into the digits", () => {
    expect(readPhone("612 345 678.00", "ES")).toMatchObject({ ok: true, digits: "34612345678", decimals: true });
    expect(readPhone("612345678,00", "ES")).toMatchObject({ ok: true, digits: "34612345678", decimals: true });
    expect(readPhone("+34612345678.0", "ES")).toMatchObject({ ok: true, digits: "34612345678", decimals: true });
    expect(readPhone("6123456789.00", "ES")).toEqual({ ok: false, reason: "no_code" });
  });

  test("names what is wrong", () => {
    expect(readPhone("3.46E+10", "ES")).toEqual({ ok: false, reason: "excel" });
    expect(readPhone("call 600111222", "ES")).toEqual({ ok: false, reason: "letters" });
    expect(readPhone("+34 6", "ES")).toEqual({ ok: false, reason: "too_short" });
    expect(readPhone("+34 600 111 222 333 444", "ES")).toMatchObject({ ok: false });
    expect(phoneProblemDetail("no_code", "6123456789", "ES")).toBe("No country code, and not a valid Spain number");
  });

  test("only a bare-digit number loses a trailing .00; a dotted one keeps every digit", () => {
    expect(readPhone("06.12.34.56.00", "FR")).toMatchObject({ ok: true, digits: "33612345600", decimals: false });
    expect(readPhone("91.555.12.00", "ES")).toMatchObject({ ok: true, digits: "34915551200", decimals: false });
    expect(readPhone("+49 30 12.34.56.00", "ES")).toMatchObject({ ok: true, digits: "493012345600", decimals: false });
  });

  test("a country code without + counts only when it is the chosen country's", () => {
    expect(readPhone("4915123456789", "DE")).toMatchObject({ ok: true, digits: "4915123456789", national: false });
    // A Spanish number with its code but no +, with Germany chosen: not read as a German one.
    expect(readPhone("34600111222", "DE")).toMatchObject({ ok: false });
    expect(readPhone("34600111222", "AT")).toMatchObject({ ok: false });
    // Spain writes no trunk 0, so a local number that would also read as Indonesian stays Spanish.
    expect(readPhone("622 000 111", "ES")).toMatchObject({ ok: true, digits: "34622000111", national: true });
    expect(readPhone("015123456789", "DE")).toMatchObject({ ok: true, digits: "4915123456789", national: true });
  });

  test("valid means the country's digit patterns, not just its lengths", () => {
    // Right length, but no Spanish or Singaporean number starts like this.
    expect(readPhone("751 111 111", "ES")).toEqual({ ok: false, reason: "no_code" });
    expect(readPhone("34751111111", "ES")).toEqual({ ok: false, reason: "no_code" });
    expect(readPhone("3011 1111", "SG")).toEqual({ ok: false, reason: "no_code" });
    expect(readPhone("6530111111", "SG")).toEqual({ ok: false, reason: "no_code" });
    // With its code too: a + or 00 does not make a number valid.
    for (const raw of ["+34 751 111 111", "0034 751 111 111"]) {
      expect(readPhone(raw, "ES")).toEqual({ ok: false, reason: "invalid" });
      expect(phoneProblemDetail("invalid", raw, "ES")).toBe("Not a valid Spain number");
    }
    expect(phoneProblemDetail("invalid", "+1 123 456 7890", "ES")).toBe("Not a valid +1 number");
    for (const [plus, zeros, digits] of [
      ["+34 612 345 678", "0034 612 345 678", "34612345678"],
      ["+33 6 12 34 56 78", "0033 6 12 34 56 78", "33612345678"],
    ]) {
      expect(readPhone(plus, "ES")).toMatchObject({ ok: true, digits, national: false });
      expect(readPhone(zeros, "ES")).toEqual(readPhone(plus, "ES"));
    }
    // A German mobile without its 0 is not ambiguous: +1 784 444 4444 is no Saint Vincent number.
    expect(readPhone("17844444444", "DE")).toMatchObject({ ok: true, digits: "4917844444444", national: true });
  });

  test("invisible direction marks around a number are dropped", () => {
    expect(readPhone("\u200E+34 600 111 222\u2069", "ES")).toMatchObject({ ok: true, digits: "34600111222" });
    expect(readPhone("\u202E600111222", "ES")).toMatchObject({ ok: true, digits: "34600111222" });
  });

  test("an empty cell has no phone number, whatever the country", () => {
    expect(readPhone("  ", "ES")).toEqual({ ok: false, reason: "no_phone" });
    expect(phoneProblemDetail("no_phone", "", "ES")).toBe("No phone number");
  });

  test("a BSUID passes as it is", () => {
    expect(readPhone("US.13491208655302741918", "ES")).toMatchObject({ ok: true, digits: "US.13491208655302741918" });
  });
});

test("countryOf reads the sending number's country", () => {
  expect(countryOf("+34 911 000 111")).toBe("ES");
  expect(countryOf("34911000111")).toBe("ES");
  expect(countryOf(null)).toBeNull();
});

test("countryOptions label each country with its code", () => {
  expect(countryOptions().find((option) => option.code === "ES")?.label).toBe("+34 Spain");
});
