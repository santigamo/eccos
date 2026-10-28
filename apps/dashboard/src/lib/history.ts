import type { CursorPage, Result } from "../server/gateway";
import { uniqueBy } from "./conversations";

/**
 * How a cursor-paged read keeps what it has loaded (`hooks/use-older-pages.ts`).
 *
 * Everything here works in WALK order: the newest item first, then each older
 * page after the one before it. The caller turns a page into walk order (a
 * thread's pages come oldest first, so they are reversed), which lets one merge
 * serve both the conversation list and a thread. Pure, so the gap rules are
 * asserted without React or a gateway.
 */

export interface Walk<T> {
  items: T[];
  /** The cursor for the page after the last loaded item. null once the walk reached the end. */
  cursor: string | null;
}

/** The older pages that close the gap between a fresh newest page and the walk's old top. */
export interface Bridge<T> {
  /** Items between the fresh page and the old top, in walk order. */
  items: T[];
  reachedTop: boolean;
}

export function startWalk<T>(page: CursorPage<T>): Walk<T> {
  return { items: page.items, cursor: page.nextCursor };
}

/** A page older than everything loaded so far. Repeats keep the first copy. */
export function appendOlder<T>(walk: Walk<T>, page: CursorPage<T>, key: (item: T) => string): Walk<T> {
  return { items: uniqueBy([...walk.items, ...page.items], key), cursor: page.nextCursor };
}

/**
 * Folds a fresh newest page into the walk. Nothing already loaded is dropped:
 * the fresh copy wins a repeat, and anything the fresh page does not carry
 * stays where it was. `bridge` is required when the fresh page misses the old top.
 */
export function absorbNewest<T>(
  walk: Walk<T>,
  fresh: CursorPage<T>,
  key: (item: T) => string,
  bridge?: Bridge<T>,
): Walk<T> {
  if (walk.items.length === 0) return startWalk(fresh);
  if (!bridge) return { items: uniqueBy([...fresh.items, ...walk.items], key), cursor: walk.cursor };
  if (bridge.reachedTop) {
    return { items: uniqueBy([...fresh.items, ...bridge.items, ...walk.items], key), cursor: walk.cursor };
  }
  // The walk ran out before the old top: the fresh page and what came after it are all there is.
  return { items: uniqueBy([...fresh.items, ...bridge.items], key), cursor: null };
}

/**
 * The pages between a fresh newest page and the walk's old top, for when more
 * arrived than one page holds. Walks older from the fresh page until a page
 * carries `top`, and keeps only what comes before it on that page.
 */
export async function bridgeTo<T>(
  fresh: CursorPage<T>,
  top: string,
  key: (item: T) => string,
  fetchOlder: (cursor: string) => Promise<Result<CursorPage<T>>>,
): Promise<Result<Bridge<T>>> {
  const items: T[] = [];
  let cursor = fresh.nextCursor;
  while (cursor !== null) {
    const result = await fetchOlder(cursor);
    if (!result.ok) return result;
    const at = result.data.items.findIndex((item) => key(item) === top);
    if (at !== -1) {
      return { ok: true, data: { items: [...items, ...result.data.items.slice(0, at)], reachedTop: true } };
    }
    items.push(...result.data.items);
    cursor = result.data.nextCursor;
  }
  return { ok: true, data: { items, reachedTop: false } };
}

/**
 * The first item, walking at most `maxPages` older pages from `first`, that
 * `match` accepts. A failed page ends the search, and so does the walk's end.
 */
export async function findInPages<T>(
  first: CursorPage<T>,
  match: (item: T) => boolean,
  fetchOlder: (cursor: string) => Promise<Result<CursorPage<T>>>,
  maxPages: number,
): Promise<T | undefined> {
  let page = first;
  for (let depth = 1; ; depth++) {
    const found = page.items.find(match);
    if (found) return found;
    if (!page.nextCursor || depth >= maxPages) return undefined;
    const next = await fetchOlder(page.nextCursor);
    if (!next.ok) return undefined;
    page = next.data;
  }
}
