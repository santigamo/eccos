const WABA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function normalizeSearchWabaId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && WABA_ID_PATTERN.test(normalized) ? normalized : undefined;
}

export function normalizeSearchStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 100 ? normalized : undefined;
}

/**
 * A ROW ID travelling in the URL. Two things are shaped like this and both are
 * the same rule: the `before` cursor, and the `?message=` / `?event=` address
 * that opens an inspection sheet — a forensic finding has to survive being
 * pasted to a colleague, so it lives in the query string like every other
 * scope the console carries.
 */
export function normalizeSearchRowId(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

export function normalizeSearchBefore(value: unknown): number | undefined {
  return normalizeSearchRowId(value);
}
