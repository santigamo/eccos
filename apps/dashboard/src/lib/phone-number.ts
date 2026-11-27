import {
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from "libphonenumber-js/min";
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
  | "no_code";

export const PHONE_PROBLEMS: Record<PhoneProblem, string> = {
  excel: "Excel rewrote it",
  letters: "letters in the number",
  too_short: "too short",
  too_long: "too long",
  invalid: "not a phone number",
  no_code: "no country code",
};

/** The long reading, for a cell's title and the skipped-rows file. */
export function phoneProblemDetail(
  problem: PhoneProblem,
  raw: string,
  country: CountryCode | null,
): string {
  if (problem === "excel")
    return `Excel turned this number into ${raw}. Format the column as text and export again.`;
  if (problem === "no_code") {
    return country
      ? `No country code, and not a valid ${countryName(country)} number`
      : "No country code, and no country chosen for numbers without one";
  }
  return PHONE_PROBLEMS[problem];
}

const SCIENTIFIC = /^\d+(?:[.,]\d+)?e\+?\d+$/i;
/** A number column exported as a number: `600111222.00`. */
const DECIMALS = /[.,]0{1,2}$/;

/** The cell starts with its country code: `+34…` or `0034…`. */
export function writtenWithCode(raw: string): boolean {
  return /^\s*(\+|00)/.test(raw);
}

/**
 * Spaces, dots, dashes and brackets go; a leading 00 is a +. With a + the number
 * is international. Without one it must be a valid national number of `country`,
 * and is never read as an international number missing its +: that guess is how
 * a stranger abroad gets the message.
 */
export function readPhone(
  raw: string,
  country: CountryCode | null,
): PhoneReading {
  const text = raw.trim();
  if (isBsuid(text))
    return {
      ok: true,
      digits: text,
      display: text,
      national: false,
      decimals: false,
    };
  if (SCIENTIFIC.test(text)) return { ok: false, reason: "excel" };
  const decimals = DECIMALS.test(text);
  const cleaned = (decimals ? text.replace(DECIMALS, "") : text)
    .replace(/[\s.\-()/]/g, "")
    .replace(/^00/, "+");
  if (/[^\d+]/.test(cleaned) || cleaned.lastIndexOf("+") > 0)
    return { ok: false, reason: "letters" };

  if (cleaned.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(cleaned);
    if (parsed?.isPossible()) {
      return {
        ok: true,
        digits: parsed.number.slice(1),
        display: parsed.formatInternational(),
        national: false,
        decimals,
      };
    }
    const length = validatePhoneNumberLength(cleaned);
    return {
      ok: false,
      reason:
        length === "TOO_SHORT"
          ? "too_short"
          : length === "TOO_LONG"
            ? "too_long"
            : "invalid",
    };
  }
  if (!country) return { ok: false, reason: "no_code" };
  const parsed = parsePhoneNumberFromString(cleaned, country);
  if (!parsed?.isValid() || parsed.country !== country)
    return { ok: false, reason: "no_code" };
  const digits = parsed.number.slice(1);
  // Written with the chosen country's code but no +: it took nothing from the country.
  return {
    ok: true,
    digits,
    display: parsed.formatInternational(),
    national: digits !== cleaned,
    decimals,
  };
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
