import { useEffect, useState } from "react";

import { findInPages } from "../lib/history";
import { replyLineOf, type ReplyLine } from "../lib/conversations";
import { getConversation, listConversations } from "../server/gateway";
import type { ConversationSummary, CursorPage, MessageRecord, Result } from "../server/gateway";

const PAGE_SIZE = 50;

/** How many list pages a thread's name may be looked up across, when its number is not on the first. */
const NAME_LOOKUP_PAGES = 5;

export interface Thread {
  page: CursorPage<MessageRecord>;
  name: string | null;
  reply: ReplyLine;
}

/** One older page of a thread, for the walk back to the customer's newest message. A failed read ends the walk. */
function olderThread(wabaId: string | undefined, waId: string, cursor: string) {
  return getConversation({ data: { wabaId, waId, limit: PAGE_SIZE, cursor } }).then(
    (read) => (read.ok ? read.data : null),
    () => null,
  );
}

/**
 * The name Meta gave a customer, read from the list. The list's first page may
 * not carry the number, so older pages are read, a few at most. A number that
 * is not found has no name, and its title falls back to the number.
 */
async function nameOf(wabaId: string | undefined, waId: string, first: CursorPage<ConversationSummary>) {
  const found = await findInPages(
    first,
    (item) => item.waId === waId,
    (cursor) => listConversations({ data: { wabaId, limit: PAGE_SIZE, cursor } }),
    NAME_LOOKUP_PAGES,
  );
  return found?.name ?? null;
}

async function readThread(
  wabaId: string | undefined,
  waId: string,
  list: CursorPage<ConversationSummary> | null,
): Promise<Result<Thread>> {
  const messages = await getConversation({ data: { wabaId, waId, limit: PAGE_SIZE } });
  if (!messages.ok) return messages;
  const [name, reply] = await Promise.all([
    list ? nameOf(wabaId, waId, list) : null,
    replyLineOf(messages.data, (cursor) => olderThread(wabaId, waId, cursor), Date.now()),
  ]);
  return { ok: true, data: { page: messages.data, name, reply } };
}

/**
 * The open thread, read on its own so opening one never reloads the route and
 * the list stays on screen. `null` is the wait: the thread was just opened and
 * nothing is known yet. `refreshed` changes when the route's loader re-ran
 * (Refresh, Live, a sent reply); the thread is then re-read behind what it shows.
 */
export function useThread(
  wabaId: string | undefined,
  waId: string | undefined,
  list: CursorPage<ConversationSummary> | null,
  refreshed: unknown,
): Result<Thread> | null {
  const scope = `${wabaId ?? ""}:${waId ?? ""}`;
  const [read, setRead] = useState<{ scope: string; result: Result<Thread> } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `list` only feeds the name lookup; `refreshed` is the trigger
  useEffect(() => {
    if (!waId) return;
    let current = true;
    readThread(wabaId, waId, list)
      .catch((err): Result<Thread> => ({ ok: false, kind: "unreachable", error: err instanceof Error ? err.message : String(err) }))
      .then((result) => {
        if (current) setRead({ scope, result });
      });
    return () => {
      current = false;
    };
  }, [scope, refreshed]);

  return waId && read?.scope === scope ? read.result : null;
}
