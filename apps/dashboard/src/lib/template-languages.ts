/**
 * Languages offered in the picker.
 *
 * A curated constant, not Meta's full list: every entry here is a promise that
 * the console renders its locale code correctly, and the list Meta accepts runs
 * to hundreds. Extending it is adding a line. A template's name is unique per
 * name+LANGUAGE pair, so this is also the second half of a row's identity.
 */
export const LANGUAGES: { code: string; label: string }[] = [
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "es_ES", label: "Spanish (Spain)" },
  { code: "es_MX", label: "Spanish (Mexico)" },
  { code: "pt_BR", label: "Portuguese (Brazil)" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ca", label: "Catalan" },
];

export const FALLBACK_LANGUAGE = "en_US";

/** "Spanish (Spain)", or the code itself for a language off the curated list. */
export function languageLabel(code: string): string {
  return LANGUAGES.find((entry) => entry.code === code)?.label ?? code;
}

/** The curated list without the codes other tabs already use, plus `current` when it is off the list. */
export function languageOptions(current: string, taken: string[] = []): { code: string; label: string }[] {
  const free = LANGUAGES.filter((entry) => entry.code === current || !taken.includes(entry.code));
  return free.some((entry) => entry.code === current) ? free : [{ code: current, label: current }, ...free];
}

/** The first curated language no tab uses yet, or `null` when all are taken. */
export function nextFreeLanguage(taken: string[]): string | null {
  return LANGUAGES.find((entry) => !taken.includes(entry.code))?.code ?? null;
}

/** The account's most used template language, so a new template starts where its others are. */
export function mostUsedLanguage(rows: { language?: string }[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.language) counts.set(row.language, (counts.get(row.language) ?? 0) + 1);
  }
  let best = FALLBACK_LANGUAGE;
  let most = 0;
  for (const [code, count] of counts) {
    if (count > most) {
      best = code;
      most = count;
    }
  }
  return best;
}
