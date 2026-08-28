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

export function normalizeSearchBefore(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}
