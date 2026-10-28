import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import type { ThreadEntry } from "../../lib/conversations";
import { fmtTs, fmtTsShort } from "../../ui";
import { GridEmptyState } from "../grid/empty-state";
import { MessageBody } from "./message-body";

const DIRECTION_LABEL = {
  in: "Customer",
  out: "Sent via Eccos",
  echo: "Sent from the WhatsApp Business app",
} as const;

export interface ConversationThreadProps {
  wabaId?: string;
  title: string;
  entries: ThreadEntry[];
  canLoadOlder: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  onLoadOlder: () => void;
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
}: ConversationThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Opening a thread starts at its newest message. Later refreshes leave the
  // scroll position alone, so a live update never yanks an operator who is
  // reading older history.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <section aria-label={`Conversation with ${title}`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-(--line) px-4 py-3">
        <Link to="/conversations" search={{ wabaId }} className="shrink-0 text-sm underline underline-offset-4 md:hidden">
          ← Conversations
        </Link>
        <h2 className="truncate text-base font-medium text-foreground">{title}</h2>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {entries.length === 0 ? (
          <GridEmptyState
            label="NO MESSAGES"
            description="Nothing in this conversation is in the retained history."
          />
        ) : (
          <>
            <div className="mb-4 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-none"
                disabled={!canLoadOlder || loadingOlder}
                aria-busy={loadingOlder}
                onClick={onLoadOlder}
              >
                ← Load older
              </Button>
              {olderFailed ? (
                <p role="alert" className="ml-3 self-center text-sm text-destructive-foreground">
                  Older messages did not load. Try again.
                </p>
              ) : null}
            </div>
            <ol aria-label="Messages" className="m-0 flex list-none flex-col gap-3 p-0">
              {entries.map((entry) => (
                <MessageBubble key={entry.message.id} entry={entry} wabaId={wabaId} />
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * One stored message, placed by direction: the customer's on the left, the
 * staff's on the right. The footer carries the facts an operator checks: the
 * exact time, what Meta last said about an outgoing message, and whether the
 * row was imported from history rather than seen live.
 */
function MessageBubble({ entry, wabaId }: { entry: ThreadEntry; wabaId?: string }) {
  const { message, edited, reactions } = entry;
  const outgoing = message.direction !== "in";
  const emojis = [...new Set(reactions)];
  return (
    <li className={outgoing ? "flex flex-col items-end gap-1" : "flex flex-col items-start gap-1"}>
      <article
        className={
          outgoing
            ? "max-w-[min(34rem,88%)] border border-(--tag-live-edge) bg-(--tag-live-bg) px-3 py-2 text-sm"
            : "max-w-[min(34rem,88%)] border border-(--line-strong) bg-muted/40 px-3 py-2 text-sm"
        }
      >
        <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {DIRECTION_LABEL[message.direction]}
        </p>
        <div className="mt-1.5 break-words text-foreground">
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
