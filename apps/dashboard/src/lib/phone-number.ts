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
 * added, which the page states out loud rather than guessing silently.
 */
export type PhoneReading =
  | { ok: true; digits: string; display: string; national: boolean }
  | { ok: false; reason: PhoneProblem };

export type PhoneProblem = "excel" | "letters" | "too_short" | "too_long" | "invalid";

export const PHONE_PROBLEMS: Record<PhoneProblem, string> = {
  excel: "Excel rewrote it",
  letters: "letters in the number",
  too_short: "too short",
  too_long: "too long",
  invalid: "not a phone number",
};

/** The long reading, for a cell's title and the skipped-rows file. */
export function phoneProblemDetail(problem: PhoneProblem, raw: string): string {
  return problem === "excel"
    ? `Excel turned this number into ${raw}. Format the column as text and export again.`
    : PHONE_PROBLEMS[problem];
}

const SCIENTIFIC = /^\d+(?:[.,]\d+)?e\+?\d+$/i;

/**
 * Spaces, dots, dashes and brackets go; a leading 00 is a +. With a + the number
 * is international. Without one it is read as a national number of `country`
 * first, and as an international number missing its + second.
 */
export function readPhone(raw: string, country: CountryCode | null): PhoneReading {
  const text = raw.trim();
  if (isBsuid(text)) return { ok: true, digits: text, display: text, national: false };
  if (SCIENTIFIC.test(text)) return { ok: false, reason: "excel" };
  const cleaned = text.replace(/[\s.\-()/]/g, "").replace(/^00/, "+");
  if (/[^\d+]/.test(cleaned) || cleaned.lastIndexOf("+") > 0) return { ok: false, reason: "letters" };

  const candidates: { text: string; national: boolean }[] = cleaned.startsWith("+")
    ? [{ text: cleaned, national: false }]
    : [...(country ? [{ text: cleaned, national: true }] : []), { text: `+${cleaned}`, national: false }];
  for (const candidate of candidates) {
    const parsed = parsePhoneNumberFromString(candidate.text, candidate.national && country ? country : undefined);
    if (parsed?.isPossible()) {
      const digits = parsed.number.slice(1);
      // A number already written with its code reads the same with or without the country.
      return { ok: true, digits, display: parsed.formatInternational(), national: digits !== cleaned.replace("+", "") };
    }
  }
  const length = validatePhoneNumberLength(candidates[0]?.text ?? cleaned, country ?? undefined);
  return { ok: false, reason: length === "TOO_SHORT" ? "too_short" : length === "TOO_LONG" ? "too_long" : "invalid" };
}

/** The country of a number written with its code, such as the sending number. */
export function countryOf(display: string | null | undefined): CountryCode | null {
  return (display && parsePhoneNumberFromString(display.startsWith("+") ? display : `+${display}`)?.country) || null;
}

/** Every country with its calling code, by English name: "+34 Spain". */
export function countryOptions(): { code: CountryCode; label: string }[] {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  return getCountries()
    .map((code) => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ code, name }) => ({ code, label: `+${getCountryCallingCode(code)} ${name}` }));
}
