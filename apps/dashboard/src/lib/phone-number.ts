import {
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from "libphonenumber-js/max";
import { isBsuid } from "@eccos/core/bsuid";

export type { CountryCode };

/**
 * One cell of a list's phone column, read the way the recipients check reads it.
 * `digits` is what the gateway is sent; `display` is what the operator checks,
 * so the two are the same number. `national` says the chosen country code was
 * added; `decimals` says a spreadsheet's `.00` was dropped from the cell.
 */
export type PhoneReading =
  | {
      ok: true;
      digits: string;
      display: string;
      national: boolean;
      decimals: boolean;
    }
  | { ok: false; reason: PhoneProblem };

export type PhoneProblem =
  | "excel"
  | "letters"
  | "too_short"
  | "too_long"
  | "invalid"
  | "no_phone"
  | "no_code"
  | "ambiguous";

export const PHONE_PROBLEMS: Record<PhoneProblem, string> = {
  excel: "Excel rewrote it",
  letters: "letters in the number",
  too_short: "too short",
  too_long: "too long",
  invalid: "not a valid number",
  no_phone: "no phone number",
  no_code: "no country code",
  ambiguous: "no country code",
};

/** The long reading, for a cell's title and the skipped-rows file. */
export function phoneProblemDetail(
  problem: PhoneProblem,
  raw: string,
  country: CountryCode | null,
): string {
  if (problem === "excel")
    return `Excel turned this number into ${raw}. Format the column as text and export again.`;
  if (problem === "no_phone") return "No phone number";
  if (problem === "invalid") {
    const number = parsePhoneNumberFromString(raw.replace(/[^\d+]/g, "").replace(/^00/, "+"));
    const where = number?.country ? countryName(number.country) : number && `+${number.countryCallingCode}`;
    return where ? `Not a valid ${where} number` : "Not a phone number";
  }
  if (problem === "ambiguous") {
    return "No country code, and it reads as a number of another country too. Write it with its + code.";
  }
  if (problem === "no_code") {
    return country
      ? `No country code, and not a valid ${countryName(country)} number`
      : "No country code, and no country chosen for numbers without one";
  }
  return PHONE_PROBLEMS[problem];
}

const SCIENTIFIC = /^\d+(?:[.,]\d+)?e\+?\d+$/i;
/** A number column exported as a number: `600111222.00`. Only on bare digits, so a dotted `91.555.12.00` keeps its digits. */
const DECIMALS = /^(\+?\d+)[.,]0{1,2}$/;
/** Direction and format marks a copy from a chat or a right-to-left sheet leaves around a number. */
const INVISIBLE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** The cell starts with its country code: `+34…` or `0034…`. */
export function writtenWithCode(raw: string): boolean {
  return /^\s*(\+|00)/.test(raw.replace(INVISIBLE, ""));
}

const fail = (reason: PhoneProblem): PhoneReading => ({ ok: false, reason });

/**
 * Spaces, dots, dashes and brackets go; a leading 00 is a +. With a + the number
 * is international and must be a valid number of its country. Without one it
 * is accepted only as a valid number of `country`: written with that country's code (tried first), or as a national
 * number. It is never read as another country's number, and a number that
 * reads as both a local one and another country's is refused: that guess is how
 * a stranger abroad gets the message.
 */
export function readPhone(raw: string, country: CountryCode | null): PhoneReading {
  const text = raw.replace(INVISIBLE, "").trim();
  if (!text) return fail("no_phone");
  if (isBsuid(text)) return { ok: true, digits: text, display: text, national: false, decimals: false };
  if (SCIENTIFIC.test(text)) return fail("excel");
  const bare = text.replace(/\s/g, "");
  const decimals = DECIMALS.test(bare);
  const cleaned = (decimals ? bare.replace(DECIMALS, "$1") : bare).replace(/[.\-()/]/g, "").replace(/^00/, "+");
  if (/[^\d+]/.test(cleaned) || cleaned.lastIndexOf("+") > 0) return fail("letters");

  if (cleaned.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(cleaned);
    if (parsed?.isValid()) {
      return { ok: true, digits: parsed.number.slice(1), display: parsed.formatInternational(), national: false, decimals };
    }
    const length = validatePhoneNumberLength(cleaned);
    return fail(length === "TOO_SHORT" ? "too_short" : length === "TOO_LONG" ? "too_long" : "invalid");
  }
  if (!country) return fail("no_code");
  const withCode = parsePhoneNumberFromString(`+${cleaned}`);
  if (withCode?.isValid() && withCode.country === country) {
    return { ok: true, digits: withCode.number.slice(1), display: withCode.formatInternational(), national: false, decimals };
  }
  const local = parsePhoneNumberFromString(cleaned, country);
  if (!local?.isValid() || local.country !== country) return fail("no_code");
  // A country whose own numbers are written with a leading 0 (Germany, Austria…) and a
  // number without one that is valid with its first digits as a code: someone abroad.
  if (withCode?.isValid() && !cleaned.startsWith("0") && writesTrunkZero(country, local.nationalNumber)) {
    return fail("ambiguous");
  }
  return { ok: true, digits: local.number.slice(1), display: local.formatInternational(), national: true, decimals };
}

/** The country's own numbers start with a trunk 0 that its international form drops. */
function writesTrunkZero(country: CountryCode, nationalNumber: string): boolean {
  return parsePhoneNumberFromString(`0${nationalNumber}`, country)?.nationalNumber === nationalNumber;
}

/** The country of a number written with its code, such as the sending number. */
export function countryOf(
  display: string | null | undefined,
): CountryCode | null {
  return (
    (display &&
      parsePhoneNumberFromString(
        display.startsWith("+") ? display : `+${display}`,
      )?.country) ||
    null
  );
}

export function countryName(code: CountryCode): string {
  return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
}

/** Every country with its calling code, by English name: "+34 Spain". */
export function countryOptions(): { code: CountryCode; label: string }[] {
  return getCountries()
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ code, name }) => ({
      code,
      label: `+${getCountryCallingCode(code)} ${name}`,
    }));
}
