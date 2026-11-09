import { isRedirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { listConversations } from "../server/gateway";
import type { ConversationSummary, CursorPage, Result } from "../server/gateway";
import { resetClientState } from "./client-state";
import { isDenial } from "./use-last-good";

const PAGE_SIZE = 50;

export interface ConversationSearch {
  q: string;
  result: Result<CursorPage<ConversationSummary>>;
}

/**
 * The conversations matching `q`, read on their own so typing never re-runs the
 * route. Each query is read fresh (no cache), and `refreshed` (the route's
 * loader data) re-reads it on the page's poll. The last finished read stays on
 * screen while a new query loads; `null` means no read has finished yet, or
 * there is no query.
 */
export function useConversationSearch(
  wabaId: string | undefined,
  q: string | undefined,
  refreshed: unknown,
): ConversationSearch | null {
  const waba = wabaId ?? "";
  const [read, setRead] = useState<{ waba: string; search: ConversationSearch } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshed` is the trigger
  useEffect(() => {
    if (!q) return;
    let current = true;
    listConversations({ data: { wabaId, limit: PAGE_SIZE, q } })
      .catch((err): Result<CursorPage<ConversationSummary>> => {
        // The root's unhandled-rejection net follows a sign-in redirect.
        if (isRedirect(err)) throw err;
        return { ok: false, kind: "unreachable", error: err instanceof Error ? err.message : String(err) };
      })
      .then((result) => {
        if (!result.ok && isDenial(result)) resetClientState();
        if (!current) return;
        // A failed re-read of the same query keeps what is on screen; the next poll retries it.
        setRead((prev) =>
          !result.ok && !isDenial(result) && prev?.waba === waba && prev.search.q === q && prev.search.result.ok
            ? prev
            : { waba, search: { q, result } },
        );
      });
    return () => {
      current = false;
    };
  }, [waba, q, refreshed]);

  if (!q || read?.waba !== waba) return null;
  return read.search;
}
