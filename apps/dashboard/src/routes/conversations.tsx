import { createFileRoute, useLoaderData } from "@tanstack/react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { ConversationList } from "../components/conversations/conversation-list";
import { ConversationThread } from "../components/conversations/conversation-thread";
import { FailureView } from "../components/dashboard/failure";
import { GridEmptyState } from "../components/grid/empty-state";
import { RefreshControls } from "../components/logs/refresh-controls";
import { useLiveRefresh } from "../hooks/use-live-refresh";
import { useOlderPages } from "../hooks/use-older-pages";
import { loaderFailure } from "../lib/failure";
import { conversationTitle, normalizeWaId, threadEntries, uniqueBy } from "../lib/conversations";
import { normalizeSearchWabaId } from "../lib/search";
import { getConversation, listConversations } from "../server/gateway";
import type { ConversationSummary, CursorPage, MessageRecord } from "../server/gateway";
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
 * and keeps what it loaded across live refreshes.
 */

const PAGE_SIZE = 50;

/** One grid for the list and the thread, shared with the pending view so the two never disagree on shape. */
const PANES =
  "grid min-h-0 flex-1 grid-cols-1 border-y border-(--line) md:h-[min(72vh,46rem)] md:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]";

type ConversationsSearch = { wabaId?: string; waId?: string };

export const Route = createFileRoute("/conversations")({
  validateSearch: (search: Record<string, unknown>): ConversationsSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    waId: normalizeWaId(search.waId),
  }),
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId, waId: search.waId }),
  loader: async ({ deps }) => {
    const [conversations, thread] = await Promise.all([
      listConversations({ data: { wabaId: deps.wabaId, limit: PAGE_SIZE } }).catch(loaderFailure),
      deps.waId
        ? getConversation({ data: { wabaId: deps.wabaId, waId: deps.waId, limit: PAGE_SIZE } }).catch(loaderFailure)
        : null,
    ]);
    return { conversations, thread };
  },
  component: ConversationsPage,
  pendingComponent: ConversationsPending,
});

function ConversationsPage() {
  const { conversations, thread } = Route.useLoaderData();
  const { wabaId, waId } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const liveRefresh = useLiveRefresh("conversations");
  const refreshControls = <RefreshControls {...liveRefresh} />;
  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;

  if (!conversations.ok) {
    return (
      <Page title="Conversations" kicker="Logs" actions={refreshControls}>
        <FailureView failure={conversations} />
      </Page>
    );
  }

  const name = conversations.data.items.find((item) => item.waId === waId)?.name ?? null;
  const now = Date.now();

  return (
    <Page title="Conversations" kicker="Logs" actions={refreshControls}>
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
              page={thread.data}
              wabaId={selectedWabaId}
              waId={waId}
              title={conversationTitle(waId, name)}
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
  const older = useOlderPages(page, (cursor) =>
    listConversations({ data: { wabaId, limit: PAGE_SIZE, cursor } }),
  );
  const items = uniqueBy([...page.items, ...older.items], (item) => item.waId);
  return (
    <ConversationList
      items={items}
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
 * One thread with its older pages. The page is newest first, as the gateway
 * returns it; the thread reads oldest first, so the list is reversed here.
 */
function ConversationThreadPane({
  page,
  wabaId,
  waId,
  title,
}: {
  page: CursorPage<MessageRecord>;
  wabaId?: string;
  waId: string;
  title: string;
}) {
  const older = useOlderPages(page, (cursor) =>
    getConversation({ data: { wabaId, waId, limit: PAGE_SIZE, cursor } }),
  );
  const newestFirst = uniqueBy([...page.items, ...older.items], (message) => message.id);
  return (
    <ConversationThread
      wabaId={wabaId}
      title={title}
      entries={threadEntries(newestFirst.reverse())}
      canLoadOlder={older.canLoadOlder}
      loadingOlder={older.loading}
      olderFailed={older.failed}
      onLoadOlder={older.loadOlder}
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
