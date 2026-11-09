import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationComposer } from "../components/conversations/conversation-composer";
import { ConversationList } from "../components/conversations/conversation-list";
import { ConversationThread } from "../components/conversations/conversation-thread";
import { NewConversation } from "../components/conversations/new-conversation";
import { FailureView } from "../components/dashboard/failure";
import { GridEmptyState } from "../components/grid/empty-state";
import { useWhenIdle } from "../hooks/use-idle-prefetch";
import { useConversationSearch } from "../hooks/use-conversation-search";
import { useLastGood } from "../hooks/use-last-good";
import { useMarkOpenRead } from "../hooks/use-mark-open-read";
import { useAlwaysLive } from "../hooks/use-live-refresh";
import { useOlderPages } from "../hooks/use-older-pages";
import { prefetchThread, useThread } from "../hooks/use-thread";
import { invalidatePage } from "../lib/invalidate";
import { failureCopy, loaderFailure, sendTextFailureCopy } from "../lib/failure";
import { sendKeyed } from "../lib/send-gate";
import {
  conversationsSearch,
  conversationTitle,
  describeEntry,
  serviceWindowOf,
  threadEntries,
  type ReplyLine,
  type ReplyTarget,
  type ThreadEntry,
} from "../lib/conversations";
import {
  canSendMessages,
  getConversation,
  listConversations,
  markConversation,
  sendReaction,
} from "../server/gateway";
import type { ConversationSummary, CursorPage, Failure, MessageRecord } from "../server/gateway";
import { Page } from "../ui";
import { LIVE_STALE_MS } from "../lib/route-stale";

/**
 * ── CONVERSATIONS ───────────────────────────────────────────────────────────
 * Who wrote to the number, and what was said, in the order it was said.
 *
 * The list is the customers; the thread is one of them, with every
 * message in and out, what Meta last reported about each outgoing one, and the
 * edits, deletions and reactions folded into the messages they act on.
 *
 * The selection is the URL (`?waId=`), like every scope on the console, so a
 * thread can be pasted to a colleague. "Load older" pages backwards by cursor
 * and keeps what it loaded across live refreshes. A refresh that fails keeps
 * showing what loaded before. Replies go out from the thread's composer when
 * the viewer may send. The page re-reads itself while the tab is visible.
 */

const PAGE_SIZE = 50;

const IDLE_THREADS = 3;

/** Updates one loaded row of the list, from outside the list pane. */
type RowPatch = (waId: string, change: Partial<ConversationSummary>) => void;

/** One grid for the list and the thread, shared with the pending view so the two never disagree on shape. */
const PANES =
  "grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] border-y border-(--line) md:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]";

export const Route = createFileRoute("/conversations")({
  staleTime: LIVE_STALE_MS,
  validateSearch: conversationsSearch,
  // The open thread is not a dep: it is read by `useThread`, so opening one
  // leaves the list on screen and waits in the thread pane alone.
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: async ({ deps }) => {
    const [conversations, canSend] = await Promise.all([
      listConversations({ data: { wabaId: deps.wabaId, limit: PAGE_SIZE } }).catch(loaderFailure),
      canSendMessages().catch(() => false),
    ]);
    return { conversations, canSend };
  },
  component: ConversationsPage,
  pendingComponent: ConversationsPending,
});

/** The failed refresh behind a page that is still showing its last good data. */
function refreshFailure(...reads: Array<{ ok: boolean; failure?: Failure | null } | null>): Failure | null {
  for (const read of reads) {
    if (read?.ok && read.failure) return read.failure;
  }
  return null;
}

function ConversationsPage() {
  const loaded = Route.useLoaderData();
  const { wabaId, waId, q } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  useAlwaysLive();
  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;
  const conversations = useLastGood(loaded.conversations, selectedWabaId ?? "");
  const search = useConversationSearch(selectedWabaId, q, loaded);
  const thread = useLastGood(
    useThread(selectedWabaId, waId, conversations.ok ? conversations.data : null, loaded),
    `${selectedWabaId ?? ""}:${waId ?? ""}`,
  );
  const patchRow = useRef<RowPatch | null>(null);
  const now = Date.now();
  const phones = ready?.scope.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];

  if (!conversations.ok) {
    return (
      <Page title="Conversations" kicker="Inbox">
        <FailureView failure={conversations} />
      </Page>
    );
  }

  const failure = refreshFailure(conversations, thread);

  // The list is the number's conversations, or the matches for `q` once a search has finished.
  let list: ReactNode;
  if (!q) {
    list = (
      <ConversationListPane
        key={selectedWabaId ?? ""}
        page={conversations.data}
        wabaId={selectedWabaId}
        linkWabaId={wabaId ?? null}
        selectedWaId={waId}
        canSend={loaded.canSend}
        patchRow={patchRow}
        now={now}
      />
    );
  } else if (!search) {
    list = <ListSkeleton />;
  } else if (!search.result.ok) {
    list = <p role="alert" className="p-4 text-sm text-destructive-foreground">Search did not load. Try again.</p>;
  } else {
    list = (
      <ConversationListPane
        key={`${selectedWabaId ?? ""}:${search.q}`}
        page={search.result.data}
        wabaId={selectedWabaId}
        linkWabaId={wabaId ?? null}
        selectedWaId={waId}
        query={search.q}
        canSend={loaded.canSend}
        patchRow={patchRow}
        now={now}
      />
    );
  }

  return (
    <Page
      title="Conversations"
      kicker="Inbox"
      fill
      actions={
        loaded.canSend && selectedWabaId ? (
          <NewConversation wabaId={selectedWabaId} linkWabaId={wabaId ?? null} phones={phones} />
        ) : undefined
      }
    >
      {failure ? <RefreshNotice failure={failure} /> : null}
      <div className={PANES}>
        {/* On a phone the list and the thread take turns: a selected thread
            hides the list, and its back link brings the list back. */}
        <div
          data-pane="list"
          className={waId ? "hidden min-h-0 min-w-0 flex-col md:flex md:border-r md:border-(--line)" : "flex min-h-0 min-w-0 flex-col md:border-r md:border-(--line)"}
        >
          <div className="border-b border-(--line) p-2">
            <ConversationSearch q={q} />
          </div>
          {list}
        </div>
        <div
          data-pane="thread"
          className={waId ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden min-h-0 min-w-0 flex-1 flex-col md:flex"}
        >
          {!waId ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <GridEmptyState
                label="NO CONVERSATION OPEN"
                description="Choose a conversation to read its messages."
              />
            </div>
          ) : !thread ? (
            <ThreadPending />
          ) : thread.ok ? (
            <ConversationThreadPane
              key={`${selectedWabaId ?? ""}:${waId}`}
              page={thread.data.page}
              wabaId={selectedWabaId}
              waId={waId}
              title={conversationTitle(waId, thread.data.name)}
              composer={composerFor(loaded.canSend, selectedWabaId, waId, thread.data.reply, phones, now)}
              canSend={loaded.canSend}
              canReply={loaded.canSend && serviceWindowOf(thread.data.reply.lastInboundAt, now).open}
              canReact={
                loaded.canSend &&
                serviceWindowOf(thread.data.reply.lastInboundAt, now).open &&
                replyPhoneNumberId(thread.data.reply, phones) !== undefined
              }
              patchRow={patchRow}
              phoneNumberId={replyPhoneNumberId(thread.data.reply, phones)}
              now={now}
              query={q}
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

/** The search box above the list. It sits outside the keyed list pane, so typing keeps its focus. */
function ConversationSearch({ q }: { q?: string }) {
  const navigate = Route.useNavigate();
  const [value, setValue] = useState(q ?? "");
  const submitted = useRef(q);
  // A `q` this box did not send (a link, the back button) replaces what is typed.
  useEffect(() => {
    if (q === submitted.current) return;
    submitted.current = q;
    setValue(q ?? "");
  }, [q]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only typing debounces; `q` is read as it stands
  useEffect(() => {
    const next = value.trim() || undefined;
    if (next === q) return;
    const timer = setTimeout(() => {
      submitted.current = next;
      navigate({ search: (prev) => ({ ...prev, q: next }), replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [value]);
  return (
    <Input
      type="search"
      aria-label="Search conversations"
      placeholder="Search name or number"
      className="rounded-none"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

/** The list with its older pages. Keyed by number, or by number and search, so each starts from its newest page. */
function ConversationListPane({
  page,
  wabaId,
  linkWabaId,
  selectedWaId,
  query,
  canSend,
  patchRow,
  now,
}: {
  page: CursorPage<ConversationSummary>;
  wabaId?: string;
  linkWabaId: string | null;
  selectedWaId?: string;
  query?: string;
  canSend?: boolean;
  patchRow: RefObject<RowPatch | null>;
  now: number;
}) {
  const router = useRouter();
  // The newest three are the likeliest clicks; same keys as a hover's prefetch.
  useWhenIdle(() => {
    for (const { waId } of page.items.slice(0, IDLE_THREADS)) prefetchThread(wabaId, waId);
  }, [wabaId]);
  const older = useOlderPages(page, {
    key: (item) => item.waId,
    fetchOlder: (cursor) => listConversations({ data: { wabaId, limit: PAGE_SIZE, cursor, q: query } }),
  });

  const { patch } = older;
  useEffect(() => {
    patchRow.current = (waId, change) =>
      patch(
        (item) => item.waId === waId,
        (item) => ({ ...item, ...change }),
      );
    return () => {
      patchRow.current = null;
    };
  }, [patch, patchRow]);

  useMarkOpenRead(older.items, canSend ? selectedWaId : undefined, async ({ waId }) => {
    const result = await markConversation({ data: { wabaId, waId, read: true } });
    if (!result.ok) return;
    older.patch(
      (item) => item.waId === waId,
      (item) => ({ ...item, unreadCount: 0, markedUnread: false }),
    );
    await invalidatePage(router);
  });

  return (
    <ConversationList
      items={older.items}
      wabaId={wabaId}
      linkWabaId={linkWabaId}
      selectedWaId={selectedWaId}
      query={query}
      now={now}
      canLoadOlder={older.canLoadOlder}
      loadingOlder={older.loading}
      olderFailed={older.failed}
      onLoadOlder={older.loadOlder}
    />
  );
}

/** The number a thread replies from: the one its window was read on; the first of the WABA's numbers is the last resort. */
function replyPhoneNumberId(
  reply: ReplyLine,
  phones: { phoneNumberId: string; displayPhoneNumber: string }[],
): string | undefined {
  return reply.phoneNumberId ?? phones[0]?.phoneNumberId;
}

/** The thread's reply box, given the reply target the thread holds. */
type ComposerFor = (reply: { replyTo: ReplyTarget | null; onClearReply: () => void }) => ReactNode;

/**
 * The reply box for a thread, or nothing: a viewer gets no composer, and a
 * thread with no number to reply from has nothing to send through.
 */
function composerFor(
  canSend: boolean,
  wabaId: string | undefined,
  waId: string,
  reply: ReplyLine,
  phones: { phoneNumberId: string; displayPhoneNumber: string }[],
  now: number,
): ComposerFor {
  const phoneNumberId = replyPhoneNumberId(reply, phones);
  return ({ replyTo, onClearReply }) => {
    if (!canSend || !wabaId || !phoneNumberId) return null;
    return (
      <ConversationComposer
        wabaId={wabaId}
        waId={waId}
        phoneNumberId={phoneNumberId}
        phones={phones}
        lastInboundAt={reply.lastInboundAt}
        now={now}
        replyTo={replyTo}
        onClearReply={onClearReply}
      />
    );
  };
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
  canSend,
  canReply,
  canReact,
  patchRow,
  phoneNumberId,
  now,
  query,
}: {
  page: CursorPage<MessageRecord>;
  wabaId?: string;
  waId: string;
  title: string;
  composer: ComposerFor;
  canSend?: boolean;
  canReply: boolean;
  canReact: boolean;
  patchRow: RefObject<RowPatch | null>;
  phoneNumberId: string | undefined;
  now: number;
  query?: string;
}) {
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const older = useOlderPages(page, {
    key: (message) => message.id,
    oldestFirst: true,
    fetchOlder: (cursor) => getConversation({ data: { wabaId, waId, limit: PAGE_SIZE, cursor } }),
  });
  const entries = useMemo(() => threadEntries(older.items), [older.items]);

  // Leaves the thread first: while it is open, a poll would mark it read again.
  async function markUnread() {
    navigate({ search: (prev) => ({ ...prev, waId: undefined }) });
    const result = await markConversation({ data: { wabaId, waId, read: false } }).catch(() => null);
    if (!result?.ok) {
      toast.error("Could not mark the conversation unread.");
      return;
    }
    patchRow.current?.(waId, { markedUnread: true });
    invalidatePage(router);
  }

  async function react(entry: ThreadEntry, emoji: string) {
    if (!wabaId || !phoneNumberId) return;
    try {
      const outcome = await sendKeyed(
        { phase: "idle" },
        { wabaId, phoneNumberId, to: waId, messageId: entry.message.id, emoji },
        (data) => sendReaction({ data }),
      );
      if (!outcome.ok) toast.error(failureCopy(outcome).title);
      else if (outcome.data.ok) invalidatePage(router);
      else toast.error(sendTextFailureCopy(outcome.data.code, outcome.data.detail).title);
    } catch (err) {
      toast.error(failureCopy(loaderFailure(err)).title);
    }
  }

  return (
    <ConversationThread
      wabaId={wabaId}
      title={title}
      entries={entries}
      canLoadOlder={older.canLoadOlder}
      loadingOlder={older.loading}
      olderFailed={older.failed}
      onLoadOlder={older.loadOlder}
      composer={composer({ replyTo, onClearReply: () => setReplyTo(null) })}
      query={query}
      onMarkUnread={canSend ? markUnread : undefined}
      onReply={canReply ? (entry) => setReplyTo({ id: entry.message.id, ...describeEntry(entry) }) : undefined}
      onReact={canReact ? react : undefined}
      now={now}
    />
  );
}

/** The thread pane while a thread opens: the list beside it stays as it is. */
function ThreadPending() {
  return (
    <div aria-busy="true" className="flex flex-1 flex-col gap-4 p-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="ml-auto h-10 w-1/2" />
      <Skeleton className="h-16 w-3/5" />
      <Skeleton className="ml-auto h-10 w-2/5" />
    </div>
  );
}

/** The list's rows while a search runs: the list pane only, the thread beside it stays. */
function ListSkeleton({ className = "" }: { className?: string }) {
  return (
    <div aria-busy="true" className={`flex flex-col gap-3 p-4 ${className}`}>
      {PENDING_ROWS.map((row) => (
        <Skeleton key={row} className="h-12 w-full" />
      ))}
    </div>
  );
}

/** Answers the wait with the page's own shape: its title, its kicker and the two panes, over skeleton rows. */
function ConversationsPending() {
  return (
    <Page title="Conversations" kicker="Inbox" fill>
      <div aria-busy="true" className={PANES}>
        <ListSkeleton className="md:border-r md:border-(--line)" />
      </div>
    </Page>
  );
}

const PENDING_ROWS = ["first", "second", "third", "fourth", "fifth"];
