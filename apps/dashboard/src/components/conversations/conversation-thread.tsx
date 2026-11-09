import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { canActOn, dividerBefore, senderLabelOf, type ThreadEntry } from "../../lib/conversations";
import { fmtTs, fmtTsShort } from "../../ui";
import { GridEmptyState } from "../grid/empty-state";
import { MessageActions } from "./message-actions";
import { MessageBody } from "./message-body";

export interface ConversationThreadProps {
  wabaId?: string;
  title: string;
  entries: ThreadEntry[];
  canLoadOlder: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  onLoadOlder: () => void;
  /** The reply box, pinned under the messages. Absent for a viewer. */
  composer?: ReactNode;
  /** The search the list was under, kept by the back link. */
  query?: string;
  /** Present only for a member who may send: the header offers "Mark unread". */
  onMarkUnread?: () => void;
  /** Absent: no Reply affordance on any message. */
  onReply?: (entry: ThreadEntry) => void;
  /** Absent: no React affordance on any message. An empty emoji removes the business's reaction. */
  onReact?: (entry: ThreadEntry, emoji: string) => void;
  /** The clock the date dividers are read against. */
  now: number;
}

/**
 * One conversation, oldest message at the top and the newest at the bottom
 * (where the operator is reading from). "Load older" sits above the first
 * message, because that is where older history arrives.
 */
export function ConversationThread({
  wabaId,
  title,
  entries,
  canLoadOlder,
  loadingOlder,
  olderFailed,
  onLoadOlder,
  composer,
  query,
  onMarkUnread,
  onReply,
  onReact,
  now,
}: ConversationThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // A reader at the bottom is followed as the content settles (images arrive
  // after the first paint); one who scrolled up into history is left alone.
  const pinned = useRef(true);
  // The reader's distance from the bottom when "load older" was pressed. Older
  // messages land above, so the same distance from the bottom keeps their place.
  const distance = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const follow = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    follow.observe(content);
    return () => follow.disconnect();
  }, []);

  // Runs when the load ends: the older messages are in by then, so the place is kept against the new height.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || distance.current === null || loadingOlder) return;
    el.scrollTop = el.scrollHeight - distance.current;
    distance.current = null;
  }, [loadingOlder]);

  const loadOlderHere = () => {
    const el = scrollRef.current;
    if (el) distance.current = el.scrollHeight - el.scrollTop;
    onLoadOlder();
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  return (
    <section aria-label={`Conversation with ${title}`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-(--line) px-4 py-3">
        <Link
          to="/conversations"
          search={{ wabaId, q: query }}
          className="shrink-0 text-sm underline underline-offset-4 md:hidden"
        >
          ← Conversations
        </Link>
        <h2 className="truncate text-base font-medium text-foreground">{title}</h2>
        {onMarkUnread ? (
          <Button type="button" variant="outline" size="sm" className="ml-auto rounded-none" onClick={onMarkUnread}>
            Mark unread
          </Button>
        ) : null}
      </header>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div ref={contentRef}>
          {entries.length === 0 ? (
            <GridEmptyState
              label="NO MESSAGES"
              description="Nothing in this conversation is in the retained history."
            />
          ) : (
            <>
              <div className="mb-4 flex justify-center">
                {canLoadOlder || loadingOlder ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-none"
                    disabled={!canLoadOlder || loadingOlder}
                    aria-busy={loadingOlder}
                    onClick={loadOlderHere}
                  >
                    ← Load older
                  </Button>
                ) : null}
                {olderFailed ? (
                  <p role="alert" className="ml-3 self-center text-sm text-destructive-foreground">
                    Messages did not load. Try again.
                  </p>
                ) : null}
              </div>
              <ol aria-label="Messages" className="m-0 flex list-none flex-col gap-3 p-0">
                {entries.map((entry, i) => {
                  const divider = dividerBefore(entries[i - 1], entry, now);
                  return (
                    <Fragment key={entry.message.id}>
                      {divider ? (
                        // biome-ignore lint/a11y/useFocusableInteractive: the separator is not interactive and takes no focus
                        <li
                          // biome-ignore lint/a11y/useSemanticElements: a date divider is a separator in the list, by design
                          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the list item carries the separator role
                          role="separator"
                          className="flex items-center gap-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase before:h-px before:flex-1 before:bg-(--line) after:h-px after:flex-1 after:bg-(--line)"
                        >
                          {divider.label}
                          {divider.newConversation ? " · New conversation" : null}
                        </li>
                      ) : null}
                      <MessageBubble entry={entry} wabaId={wabaId} onReply={onReply} onReact={onReact} />
                    </Fragment>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      </div>
      {composer}
    </section>
  );
}

/**
 * One stored message, placed by direction: the customer's on the left, the
 * staff's on the right. The footer carries the facts an operator checks: the
 * exact time, what Meta last said about an outgoing message, and whether the
 * row was imported from history rather than seen live.
 */
function MessageBubble({
  entry,
  wabaId,
  onReply,
  onReact,
}: {
  entry: ThreadEntry;
  wabaId?: string;
  onReply?: (entry: ThreadEntry) => void;
  onReact?: (entry: ThreadEntry, emoji: string) => void;
}) {
  const { message, edited, reactions } = entry;
  const outgoing = message.direction !== "in";
  const emojis = [...new Set(reactions)];
  return (
    <li
      id={`message-${message.id}`}
      className={outgoing ? "group flex flex-col items-end gap-1" : "group flex flex-col items-start gap-1"}
    >
      {/* The row is full width, so the bubble's own max-width still measures against the thread. */}
      <div className={`flex w-full items-center gap-1 ${outgoing ? "flex-row-reverse" : ""}`}>
        <article
          className={
            outgoing
              ? "max-w-[min(34rem,88%)] border border-(--tag-live-edge) bg-(--tint-live) px-3 py-2 text-sm"
              : "max-w-[min(34rem,88%)] border border-(--line-strong) bg-muted/40 px-3 py-2 text-sm"
          }
        >
          <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            {senderLabelOf(message)}
          </p>
          <div className="mt-1.5 break-words text-foreground">
            {entry.quoted ? <QuoteBlock quoted={entry.quoted} /> : null}
            <MessageBody entry={entry} wabaId={wabaId} />
          </div>
          <footer className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <time dateTime={fmtTs(message.at)} title={fmtTs(message.at)} className="tabular-nums">
              {fmtTsShort(message.at)}
            </time>
            {outgoing && message.status ? (
              <span className={message.status === "failed" ? "text-destructive-foreground" : undefined}>
                {message.status}
                {message.status === "failed" && message.error ? `: ${message.error}` : ""}
              </span>
            ) : null}
            {edited ? <span>Edited</span> : null}
            {message.origin === "history" ? <span>Imported history</span> : null}
          </footer>
        </article>
        {canActOn(entry) && (onReply || onReact) ? (
          <MessageActions entry={entry} onReply={onReply} onReact={onReact} />
        ) : null}
      </div>
      {emojis.length > 0 ? (
        <ul aria-label="Reactions" className="m-0 flex list-none gap-1 p-0 text-sm">
          {emojis.map((emoji) => {
            const count = reactions.filter((reaction) => reaction === emoji).length;
            return (
              <li key={emoji} className="border border-(--line-strong) bg-muted/40 px-1.5 py-0.5">
                {emoji}
                {count > 1 ? <span className="ml-1 text-xs tabular-nums">{count}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/** The message a reply quotes. When it is in the thread, the quote scrolls to it; when not, it only says so. */
function QuoteBlock({ quoted }: { quoted: NonNullable<ThreadEntry["quoted"]> }) {
  const line = "mb-1.5 border-l-2 border-(--line-strong) pl-2 text-xs";
  const body = (
    <>
      {quoted.sender ? <span className="block font-medium">{quoted.sender}</span> : null}
      <span className="block truncate text-muted-foreground">{quoted.preview}</span>
    </>
  );
  if (!quoted.found) return <div className={line}>{body}</div>;
  return (
    <button
      type="button"
      className={`${line} block w-full cursor-pointer text-left`}
      onClick={() => document.getElementById(`message-${quoted.id}`)?.scrollIntoView({ block: "center" })}
    >
      {body}
    </button>
  );
}
