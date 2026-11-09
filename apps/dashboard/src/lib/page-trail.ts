export type PageCursor = string | number;

/** The cursors of the pages before this one, oldest visit first. `null` is the first page, which has none. */
export type PageTrail = (PageCursor | null)[];

export type PageTarget = { cursor: PageCursor | undefined; trail: PageTrail | undefined };

export type PagerState = {
  /** Undefined when a cursor was opened without its trail: an old link cannot know how deep it is. */
  page: number | undefined;
  previous: PageTarget | undefined;
  next: PageTarget | undefined;
};

const MAX_TRAIL = 200;
const MAX_CURSOR_LENGTH = 128;

function isCursor(value: unknown): value is PageCursor {
  return typeof value === "number" || (typeof value === "string" && value.length <= MAX_CURSOR_LENGTH);
}

/** Every read only walks older, so going back needs the cursors that led here. */
export function normalizeSearchTrail(value: unknown, cursor: unknown): PageTrail | undefined {
  if (cursor === undefined || !Array.isArray(value)) return undefined;
  if (value.length === 0 || value.length > MAX_TRAIL || value[0] !== null) return undefined;
  return value.slice(1).every(isCursor) ? (value as PageTrail) : undefined;
}

export function pagerState(
  cursor: PageCursor | undefined,
  trail: PageTrail | undefined,
  nextCursor: PageCursor | null,
): PagerState {
  const nextTrail = cursor === undefined ? [null] : trail && [...trail, cursor];
  const next = nextCursor === null ? undefined : { cursor: nextCursor, trail: nextTrail };
  if (cursor === undefined) return { page: 1, previous: undefined, next };
  if (!trail) return { page: undefined, previous: undefined, next };
  return {
    page: trail.length + 1,
    previous: { cursor: trail.at(-1) ?? undefined, trail: trail.length > 1 ? trail.slice(0, -1) : undefined },
    next,
  };
}

/**
 * Splits a read of `size + 1` rows into the page and the cursor to the next one.
 * Inferring "there is more" from a full page sends an exact multiple of the
 * page size to an empty page.
 */
export function pageOfRows<T extends { id: number }>(
  rows: T[],
  size: number,
): { rows: T[]; nextCursor: number | null } {
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > size && last ? last.id : null };
}
