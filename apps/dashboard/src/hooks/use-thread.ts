import { useEffect, useRef, useState } from "react";

import type { ReplyLine } from "../lib/conversations";
import { getThreadView } from "../server/gateway";
import { onClientReset, resetClientState } from "./client-state";
import { createReadCache } from "./read-cache";
import { isDenial } from "./use-last-good";
import type { ConversationSummary, CursorPage, MessageRecord, Result } from "../server/gateway";

const PAGE_SIZE = 50;

/** Long enough that a hover and the click it leads to share one read. */
const THREAD_TTL_MS = 10_000;

const threadKey = (wabaId: string | undefined, waId: string) => `${wabaId ?? ""}:${waId}`;

export interface Thread {
  page: CursorPage<MessageRecord>;
  name: string | null;
  reply: ReplyLine;
}

/** One server request: the gateway returns the page, the contact's name and the reply line together. */
async function readThread(wabaId: string | undefined, waId: string): Promise<Result<Thread>> {
  const view = await getThreadView({ data: { wabaId, waId, limit: PAGE_SIZE } });
  if (!view.ok) return view;
  const { page, contactName, reply } = view.data;
  return { ok: true, data: { page, name: contactName, reply } };
}

const threads = createReadCache<Thread>(THREAD_TTL_MS);
onClientReset(threads.clear);

const loadThread = (wabaId: string | undefined, waId: string, force = false) =>
  threads.read(threadKey(wabaId, waId), () => readThread(wabaId, waId), force);

/** Starts the read for a thread the operator is about to open; the click joins it. */
export function prefetchThread(wabaId: string | undefined, waId: string, _list?: CursorPage<ConversationSummary> | null): void {
  loadThread(wabaId, waId).catch(() => {});
}

/**
 * The open thread, read on its own so opening one never reloads the route and
 * the list stays on screen. `null` is the wait: the thread was just opened and
 * nothing is known yet; one read before shows at once and is re-read behind
 * it. `refreshed` changes when the route's loader re-ran (Refresh, Live, a
 * sent reply); the thread is then re-read, never served from the cache.
 */
export function useThread(
  wabaId: string | undefined,
  waId: string | undefined,
  _list: CursorPage<ConversationSummary> | null,
  refreshed: unknown,
): Result<Thread> | null {
  const scope = threadKey(wabaId, waId ?? "");
  const [read, setRead] = useState<{ scope: string; result: Result<Thread> } | null>(null);
  const seen = useRef(refreshed);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshed` is the trigger
  useEffect(() => {
    if (!waId) return;
    const force = seen.current !== refreshed;
    seen.current = refreshed;
    let current = true;
    loadThread(wabaId, waId, force)
      .catch((err): Result<Thread> => ({ ok: false, kind: "unreachable", error: err instanceof Error ? err.message : String(err) }))
      .then((result) => {
        if (!result.ok && isDenial(result)) resetClientState();
        if (current) setRead({ scope, result });
      });
    return () => {
      current = false;
    };
  }, [scope, refreshed]);

  if (!waId) return null;
  if (read?.scope === scope) return read.result;
  const kept = threads.peek(scope);
  return kept ? { ok: true, data: kept } : null;
}
