import { useEffect, useMemo, useRef, useState } from "react";

import { absorbNewest, appendOlder, bridgeTo, startWalk, type Walk } from "../lib/history";
import type { CursorPage, Result } from "../server/gateway";

export interface OlderPagesOptions<T> {
  key: (item: T) => string;
  fetchOlder: (cursor: string) => Promise<Result<CursorPage<T>>>;
  /** A thread's pages come oldest first: the walk is kept newest first and returned oldest first. */
  oldestFirst?: boolean;
}

/**
 * "Load older" for a cursor-paged read (the conversation list and a thread).
 *
 * `newest` is the route loader's first page, replaced on every live refresh.
 * Older pages are fetched on demand and kept here, so a refresh folds the fresh
 * page into what was already loaded. When more arrived than one page holds,
 * the gap is fetched before the refresh is shown (`bridgeTo`).
 */
export function useOlderPages<T>(newest: CursorPage<T>, { key, fetchOlder, oldestFirst = false }: OlderPagesOptions<T>) {
  const toWalk = (page: CursorPage<T>): CursorPage<T> =>
    oldestFirst ? { items: [...page.items].reverse(), nextCursor: page.nextCursor } : page;
  const [walk, setWalk] = useState<Walk<T>>(() => startWalk(toWalk(newest)));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const synced = useRef(newest);

  const fetchOlderWalk = async (cursor: string): Promise<Result<CursorPage<T>>> => {
    const result = await fetchOlder(cursor);
    return result.ok ? { ok: true, data: toWalk(result.data) } : result;
  };

  // A new page from the loader is the only trigger; the walk is read as it stood then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the loader's page, not on walk state
  useEffect(() => {
    if (synced.current === newest) return;
    synced.current = newest;
    const fresh = toWalk(newest);
    const top = walk.items[0];
    if (!top || fresh.items.some((item) => key(item) === key(top))) {
      setWalk((prev) => absorbNewest(prev, fresh, key));
      return;
    }
    // A newer refresh can start before this fetch lands; the stale one must not land over it.
    let current = true;
    void bridgeTo(fresh, key(top), key, fetchOlderWalk).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setWalk((prev) => absorbNewest(prev, fresh, key, result.data));
    });
    return () => {
      current = false;
    };
  }, [newest]);

  const loadOlder = async () => {
    if (walk.cursor === null || loading) return;
    setLoading(true);
    setFailed(false);
    let result: Result<CursorPage<T>> | null = null;
    try {
      result = await fetchOlderWalk(walk.cursor);
    } catch {
      result = null;
    }
    setLoading(false);
    if (!result || !result.ok) {
      setFailed(true);
      return;
    }
    const page = result.data;
    setWalk((prev) => appendOlder(prev, page, key));
  };

  const items = useMemo(() => (oldestFirst ? [...walk.items].reverse() : walk.items), [walk.items, oldestFirst]);

  return {
    items,
    canLoadOlder: walk.cursor !== null && !loading,
    loading,
    failed,
    loadOlder: () => void loadOlder(),
  };
}
