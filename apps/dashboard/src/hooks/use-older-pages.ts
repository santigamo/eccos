import { useState } from "react";

import type { CursorPage, Result } from "../server/gateway";

/**
 * "Load older" for a cursor-paged read (conversations and their threads).
 *
 * The newest page belongs to the route's loader, so a live refresh replaces it.
 * Older pages are fetched on demand and kept here, so a refresh never throws
 * away the history the operator already scrolled back through.
 */
export interface OlderPages<T> {
  /** Every older item loaded so far, in the order the gateway returned them. */
  items: T[];
  /** The cursor for the next older page. `undefined` until one has been loaded. */
  cursor: string | null | undefined;
}

export const NO_OLDER_PAGES: OlderPages<never> = { items: [], cursor: undefined };

/** The cursor a "load older" should send: the last older page's, else the newest page's. */
export function olderCursor<T>(state: OlderPages<T>, newest: CursorPage<T>): string | null {
  return (state.cursor === undefined ? newest.nextCursor : state.cursor) ?? null;
}

export function takeOlderPage<T>(state: OlderPages<T>, page: CursorPage<T>): OlderPages<T> {
  return { items: [...state.items, ...page.items], cursor: page.nextCursor };
}

export function useOlderPages<T>(
  newest: CursorPage<T>,
  fetchOlder: (cursor: string) => Promise<Result<CursorPage<T>>>,
) {
  const [state, setState] = useState<OlderPages<T>>(NO_OLDER_PAGES);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const cursor = olderCursor(state, newest);

  const loadOlder = async () => {
    if (cursor === null || loading) return;
    setLoading(true);
    setFailed(false);
    let result: Result<CursorPage<T>> | null = null;
    try {
      result = await fetchOlder(cursor);
    } catch {
      result = null;
    }
    setLoading(false);
    if (!result || !result.ok) {
      setFailed(true);
      return;
    }
    const page = result.data;
    setState((prev) => takeOlderPage(prev, page));
  };

  return {
    items: state.items,
    canLoadOlder: cursor !== null && !loading,
    loading,
    failed,
    loadOlder: () => void loadOlder(),
  };
}
