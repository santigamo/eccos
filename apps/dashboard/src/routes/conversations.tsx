import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ConversationComposer } from "../components/conversations/conversation-composer";
import { ConversationList } from "../components/conversations/conversation-list";
import { ConversationThread } from "../components/conversations/conversation-thread";
import { FailureView } from "../components/dashboard/failure";
import { GridEmptyState } from "../components/grid/empty-state";
import { RefreshControls } from "../components/logs/refresh-controls";
import { useLastGood } from "../hooks/use-last-good";
import { useLiveRefresh } from "../hooks/use-live-refresh";
import { useOlderPages } from "../hooks/use-older-pages";
import { findInPages } from "../lib/history";
import { failureCopy, loaderFailure } from "../lib/failure";
import {
  conversationsSearch,
  conversationTitle,
  lastInboundAt,
  threadEntries,
  threadPhoneNumberId,
} from "../lib/conversations";
import { canSendMessages, getConversation, listConversations } from "../server/gateway";
import type { ConversationSummary, CursorPage, Failure, MessageRecord } from "../server/gateway";
import { Page } from "../ui";

/**
 * ── CONVERSATIONS ───────────────────────────────────────────────────────────
 * Who wrote to the number, and what was said, in the order it was said.
 *
 * Read-only. The list is the customers; the thread is one of them, with every
 * message in and out, what Meta last reported about each outgoing one, and the
 * edits, deletions and reactions folded into the messages they act on.
 *
 * The selection is the URL (`?waId=`), like every scope on the console, so a
 * thread can be pasted to a colleague. "Load older" pages backwards by cursor
 * and keeps what it loaded across live refreshes. A refresh that fails keeps
 * showing what loaded before.
 */

const PAGE_SIZE = 50;

/** How many list pages a thread's name may be looked up across, when its number is not on the first. */
const NAME_LOOKUP_PAGES = 5;

/** One grid for the list and the thread, shared with the pending view so the two never disagree on shape. */
const PANES =
  "grid min-h-0 flex-1 grid-cols-1 border-y border-(--line) md:h-[min(72vh,46rem)] md:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]";

export const Route = createFileRoute("/conversations")({
  validateSearch: conversationsSearch,
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId, waId: search.waId }),
  loader: async ({ deps }) => {
    const [conversations, messages, canSend] = await Promise.all([
      listConversations({ data: { wabaId: deps.wabaId, limit: PAGE_SIZE } }).catch(loaderFailure),
      deps.waId
        ? getConversation({ data: { wabaId: deps.wabaId, waId: deps.waId, limit: PAGE_SIZE } }).catch(loaderFailure)
        : null,
      canSendMessages().catch(() => false),
    ]);
    const waId = deps.waId;
    if (!messages?.ok || !waId) return { conversations, thread: messages?.ok ? null : messages, canSend };
    const name = conversations.ok ? await nameOf(deps.wabaId, waId, conversations.data) : null;
    const newest = await lastInboundAt(messages.data, (cursor) => olderThread(deps.wabaId, waId, cursor), Date.now());
    return {
      conversations,
      thread: { ok: true as const, data: { page: messages.data, name, lastInboundAt: newest } },
      canSend,
    };
  },
  component: ConversationsPage,
  pendingComponent: ConversationsPending,
});

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

/** The failed refresh behind a page that is still showing its last good data. */
function refreshFailure(...reads: Array<{ ok: boolean; failure?: Failure | null } | null>): Failure | null {
  for (const read of reads) {
    if (read?.ok && read.failure) return read.failure;
  }
  return null;
}

function ConversationsPage() {
  const loaded = Route.useLoaderData();
  const { wabaId, waId } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const liveRefresh = useLiveRefresh("conversations");
  const refreshControls = <RefreshControls {...liveRefresh} />;
  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;
  const conversations = useLastGood(loaded.conversations, selectedWabaId ?? "");
  const thread = useLastGood(loaded.thread, `${selectedWabaId ?? ""}:${waId ?? ""}`);
  const now = Date.now();
  const phones = ready?.scope.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];

  if (!conversations.ok) {
    return (
      <Page title="Conversations" kicker="Inbox" actions={refreshControls}>
        <FailureView failure={conversations} />
      </Page>
    );
  }

  const failure = refreshFailure(conversations, thread);

  return (
    <Page title="Conversations" kicker="Inbox" actions={refreshControls}>
      {failure ? <RefreshNotice failure={failure} /> : null}
      <div className={PANES}>
        {/* On a phone the list and the thread take turns: a selected thread
            hides the list, and its back link brings the list back. */}
        <div
          data-pane="list"
          className={waId ? "hidden min-h-0 min-w-0 flex-col md:flex md:border-r md:border-(--line)" : "flex min-h-0 min-w-0 flex-col md:border-r md:border-(--line)"}
        >
          <ConversationListPane
            key={selectedWabaId ?? ""}
            page={conversations.data}
            wabaId={selectedWabaId}
            selectedWaId={waId}
            now={now}
          />
        </div>
        <div
          data-pane="thread"
          className={waId ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden min-h-0 min-w-0 flex-1 flex-col md:flex"}
        >
          {!waId || !thread ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <GridEmptyState
                label="NO CONVERSATION OPEN"
                description="Choose a conversation to read its messages."
              />
            </div>
          ) : thread.ok ? (
            <ConversationThreadPane
              key={`${selectedWabaId ?? ""}:${waId}`}
              page={thread.data.page}
              wabaId={selectedWabaId}
              waId={waId}
              title={conversationTitle(waId, thread.data.name)}
              composer={composerFor(loaded.canSend, selectedWabaId, waId, thread.data, phones, now)}
            />
          ) : (
            <div className="p-4">
              <FailureView failure={thread} />
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}

/** A refresh that failed while the page keeps showing what loaded before. */
function RefreshNotice({ failure }: { failure: Failure }) {
  const { title } = failureCopy(failure);
  return (
    <p role="alert" className="border-b border-(--line) px-4 py-2 text-sm text-destructive-foreground">
      Could not refresh ({title.toLowerCase()}). Showing what loaded before.
    </p>
  );
}

/**
 * The list with its older pages. Keyed by number in the parent, so switching
 * numbers starts from that number's newest page.
 */
function ConversationListPane({
  page,
  wabaId,
  selectedWaId,
  now,
}: {
  page: CursorPage<ConversationSummary>;
  wabaId?: string;
  selectedWaId?: string;
  now: number;
}) {
  const older = useOlderPages(page, {
    key: (item) => item.waId,
    fetchOlder: (cursor) => listConversations({ data: { wabaId, limit: PAGE_SIZE, cursor } }),
  });
  return (
    <ConversationList
      items={older.items}
      wabaId={wabaId}
      selectedWaId={selectedWaId}
      now={now}
      canLoadOlder={older.canLoadOlder}
      loadingOlder={older.loading}
      olderFailed={older.failed}
      onLoadOlder={older.loadOlder}
    />
  );
}

/**
 * The reply box for a thread, or nothing: a viewer gets no composer, and a
 * thread with no number to reply from has nothing to send through.
 */
function composerFor(
  canSend: boolean,
  wabaId: string | undefined,
  waId: string,
  thread: { page: CursorPage<MessageRecord>; lastInboundAt: number | null },
  phones: { phoneNumberId: string; displayPhoneNumber: string }[],
  now: number,
): ReactNode {
  const phoneNumberId = threadPhoneNumberId(thread.page.items) ?? phones[0]?.phoneNumberId;
  if (!canSend || !wabaId || !phoneNumberId) return null;
  return (
    <ConversationComposer
      wabaId={wabaId}
      waId={waId}
      phoneNumberId={phoneNumberId}
      phones={phones}
      lastInboundAt={thread.lastInboundAt}
      now={now}
    />
  );
}

/**
 * One thread with its older pages. The gateway returns each page oldest first
 * and walks older with the cursor, so the older pages are kept before the ones
 * already loaded (`oldestFirst`).
 */
function ConversationThreadPane({
  page,
  wabaId,
  waId,
  title,
  composer,
}: {
  page: CursorPage<MessageRecord>;
  wabaId?: string;
  waId: string;
  title: string;
  composer: ReactNode;
}) {
  const older = useOlderPages(page, {
    key: (message) => message.id,
    oldestFirst: true,
    fetchOlder: (cursor) => getConversation({ data: { wabaId, waId, limit: PAGE_SIZE, cursor } }),
  });
  const entries = useMemo(() => threadEntries(older.items), [older.items]);
  return (
    <ConversationThread
      wabaId={wabaId}
      title={title}
      entries={entries}
      canLoadOlder={older.canLoadOlder}
      loadingOlder={older.loading}
      olderFailed={older.failed}
      onLoadOlder={older.loadOlder}
      composer={composer}
    />
  );
}

/** Answers the wait with the page's own shape: its title, its kicker and the two panes, over skeleton rows. */
function ConversationsPending() {
  return (
    <Page title="Conversations" kicker="Logs">
      <div aria-busy="true" className={PANES}>
        <div className="flex flex-col gap-3 p-4 md:border-r md:border-(--line)">
          {PENDING_ROWS.map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </Page>
  );
}

const PENDING_ROWS = ["first", "second", "third", "fourth", "fifth"];
