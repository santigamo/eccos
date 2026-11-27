import { describe, expect, test } from "bun:test";
import { countryOf, countryOptions, readPhone } from "../src/lib/phone-number";

describe("readPhone", () => {
  test("a number with its code is international, whatever its punctuation", () => {
    for (const raw of ["+34 600 111 222", "0034 600-111-222", "+34 (600) 111.222"]) {
      expect(readPhone(raw, "ES")).toMatchObject({ ok: true, digits: "34600111222", national: false });
    }
    expect(readPhone("+1 (415) 555-0100", "ES")).toMatchObject({ ok: true, digits: "14155550100" });
  });

  test("a national number takes the chosen country, and says so", () => {
    expect(readPhone("600 111 222", "ES")).toEqual({ ok: true, digits: "34600111222", display: "+34 600 11 12 22", national: true });
    expect(readPhone("415 555 0100", "US")).toMatchObject({ digits: "14155550100", national: true });
  });

  test("without a +, the international reading is the fallback, never a guess of the country", () => {
    expect(readPhone("34600111222", "ES")).toMatchObject({ ok: true, digits: "34600111222", national: false });
    expect(readPhone("600111222", null)).toMatchObject({ ok: false });
  });

  test("names what is wrong", () => {
    expect(readPhone("3.46E+10", "ES")).toEqual({ ok: false, reason: "excel" });
    expect(readPhone("call 600111222", "ES")).toEqual({ ok: false, reason: "letters" });
    expect(readPhone("123", "ES")).toEqual({ ok: false, reason: "too_short" });
    expect(readPhone("+34 600 111 222 333 444", "ES")).toMatchObject({ ok: false });
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
