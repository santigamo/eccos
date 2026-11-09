import { Link } from "@tanstack/react-router";
import { prefetchThread } from "../../hooks/use-thread";
import {
  FileTextIcon,
  ImageIcon,
  MapPinIcon,
  MessageSquareTextIcon,
  MicIcon,
  PencilIcon,
  SmilePlusIcon,
  StickerIcon,
  UserRoundIcon,
  VideoIcon,
  BanIcon,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { conversationTitle, previewOf, relativeTime } from "../../lib/conversations";
import { fmtTs, fmtTsShort } from "../../ui";
import type { ConversationSummary } from "../../server/gateway";
import { GridEmptyState } from "../grid/empty-state";

/** The list's own voice: one icon per kind of message the preview can name. */
const TYPE_ICON: Record<string, LucideIcon> = {
  image: ImageIcon,
  sticker: StickerIcon,
  audio: MicIcon,
  video: VideoIcon,
  document: FileTextIcon,
  location: MapPinIcon,
  contacts: UserRoundIcon,
  reaction: SmilePlusIcon,
  edit: PencilIcon,
  revoke: BanIcon,
};

export interface ConversationListProps {
  items: ConversationSummary[];
  wabaId?: string;
  /**
   * The `wabaId` the row links carry: the URL's own, `null` when it has none
   * (the default number). Writing the resolved id instead changes the root and
   * list loaders' deps and reloads both. Defaults to `wabaId`.
   */
  linkWabaId?: string | null;
  selectedWaId?: string;
  /** The search the rows answer; the empty state names it and the row links keep it. */
  query?: string;
  now: number;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  onLoadOlder: () => void;
}

/**
 * The conversations of one number, most recent first. Each row is a real link
 * to its thread (the `?waId=` address), so the selection survives a reload and
 * can be pasted to a colleague.
 */
export function ConversationList({
  items,
  wabaId,
  linkWabaId,
  selectedWaId,
  query,
  now,
  canLoadOlder,
  loadingOlder,
  olderFailed,
  onLoadOlder,
}: ConversationListProps) {
  return (
    <section aria-label="Conversations" className="flex min-h-0 flex-1 flex-col">
      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          {query ? (
            <GridEmptyState label="NO MATCHES" description={`No conversation matches "${query}".`} />
          ) : (
            <GridEmptyState
              label="NO CONVERSATIONS YET"
              description="Customers who message this number, and the replies sent to them, will appear here."
            />
          )}
        </div>
      ) : (
        <>
          {/* relative: the rows' sr-only text is absolutely positioned, and would otherwise escape this scroller and stretch the page. */}
          <ol className="relative m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
            {items.map((conversation) => (
              <ConversationRow
                key={conversation.waId}
                conversation={conversation}
                wabaId={wabaId}
                linkWabaId={linkWabaId === undefined ? wabaId : (linkWabaId ?? undefined)}
                selected={conversation.waId === selectedWaId}
                query={query}
                now={now}
              />
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-(--line) p-3">
            {olderFailed ? (
              <p role="alert" className="mr-auto text-sm text-destructive-foreground">
                Older conversations did not load. Try again.
              </p>
            ) : null}
            {canLoadOlder || loadingOlder ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-none"
                disabled={!canLoadOlder || loadingOlder}
                aria-busy={loadingOlder}
                onClick={onLoadOlder}
              >
                Load older →
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function ConversationRow({
  conversation,
  wabaId,
  linkWabaId,
  selected,
  query,
  now,
}: {
  conversation: ConversationSummary;
  wabaId?: string;
  linkWabaId?: string;
  selected: boolean;
  query?: string;
  now: number;
}) {
  const { waId, name, unreadCount, markedUnread, messageCount, lastMessage } = conversation;
  const unread = unreadCount > 0 || markedUnread;
  const Icon = TYPE_ICON[lastMessage.type] ?? MessageSquareTextIcon;
  const prefetch = () => prefetchThread(wabaId, waId, { items: [conversation], nextCursor: null });
  return (
    <li>
      <Link
        to="/conversations"
        search={{ wabaId: linkWabaId, waId, q: query }}
        aria-current={selected ? "true" : undefined}
        data-selected={selected}
        onMouseEnter={prefetch}
        onFocus={prefetch}
        className="block border-b border-(--line) px-4 py-3 outline-none transition-colors hover:bg-white/[.03] focus-visible:ring-1 focus-visible:ring-ring data-[selected=true]:bg-(--tag-live-bg) data-[selected=true]:shadow-[inset_2px_0_0_0_var(--color-glow)]"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className={`truncate ${unread ? "font-semibold" : "font-medium"} text-foreground`}>
            {conversationTitle(waId, name)}
          </span>
          <time
            dateTime={fmtTs(lastMessage.at)}
            title={fmtTsShort(lastMessage.at)}
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
          >
            {relativeTime(lastMessage.at, now)}
          </time>
        </span>
        <span className="mt-1 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{previewOf(lastMessage)}</span>
          </span>
          {unreadCount > 0 ? (
            <span className="shrink-0 border border-(--tag-live-edge) bg-(--tag-live-bg) px-1.5 text-xs tabular-nums text-(color:--tag-live-ink)">
              {unreadCount}
              <span className="sr-only"> unread messages</span>
            </span>
          ) : markedUnread ? (
            <span className="size-2 shrink-0 bg-(--color-glow)">
              <span className="sr-only">Marked unread</span>
            </span>
          ) : (
            <span className="shrink-0 text-xs tabular-nums">
              {messageCount}
              <span className="sr-only"> messages</span>
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}
