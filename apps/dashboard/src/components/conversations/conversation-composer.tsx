import { useRouter } from "@tanstack/react-router";
import { useState, type FormEvent, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { isSendKey, serviceWindowOf } from "../../lib/conversations";
import { failureCopy, sendTextFailureCopy } from "../../lib/failure";
import type { Result, SendTextResult } from "../../server/gateway";
import { sendText } from "../../server/gateway";
import type { SendTestPhone } from "../templates/send-test-sheet";
import { SendTemplateSheet } from "./send-template-sheet";

/** The server function the composer sends through, typed as the composer calls it. */
type SendText = (input: {
  data: { wabaId: string; phoneNumberId: string; to: string; text: string };
}) => Promise<Result<SendTextResult>>;

export type ReplyOutcome =
  | { sent: true }
  | { sent: false; title: string; detail: string; secondary: string | null };

/**
 * One reply, sent through `send`. A boundary failure keeps its own copy; a
 * refused send is named by its code. Meta's own sentence rides along only for
 * the two codes it explains better than the console does.
 */
export async function submitReply(
  send: SendText,
  target: { wabaId: string; phoneNumberId: string; waId: string },
  text: string,
): Promise<ReplyOutcome> {
  const { wabaId, phoneNumberId, waId } = target;
  const result = await send({ data: { wabaId, phoneNumberId, to: waId, text } });
  if (!result.ok) {
    const copy = failureCopy(result);
    return { sent: false, title: copy.title, detail: copy.detail, secondary: null };
  }
  if (result.data.ok) return { sent: true };
  const copy = sendTextFailureCopy(result.data.code, result.data.detail);
  const explained = result.data.code === "graph" || result.data.code === "window_closed";
  return {
    sent: false,
    title: copy.title,
    detail: copy.detail,
    secondary: explained ? result.data.detail : null,
  };
}

const LABEL = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";

export interface ConversationComposerProps {
  wabaId: string;
  /** The customer's number, digits only. */
  waId: string;
  /** The number the thread is on: replies go out from it. */
  phoneNumberId: string;
  phones: SendTestPhone[];
  /** The customer's newest inbound message, or null when none was found. */
  lastInboundAt: number | null;
  now: number;
}

/**
 * The reply box at the foot of a thread. Only shown to a member who may send
 * (the page decides that). Inside the customer service window it is a text
 * box; outside it, free text is refused by WhatsApp, so the box gives way to
 * "Send a template".
 */
export function ConversationComposer({ lastInboundAt, now, ...thread }: ConversationComposerProps) {
  const router = useRouter();
  const service = serviceWindowOf(lastInboundAt, now);
  const onSent = () => void router.invalidate();
  if (!service.open) {
    return <TemplateOnlyReply label={service.label} onSent={onSent} {...thread} />;
  }
  return <FreeTextReply label={service.label} onSent={onSent} {...thread} />;
}

function FreeTextReply({
  label,
  wabaId,
  waId,
  phoneNumberId,
  onSent,
}: Pick<ConversationComposerProps, "wabaId" | "waId" | "phoneNumberId"> & { label: string; onSent: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Extract<ReplyOutcome, { sent: false }> | null>(null);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const outcome = await submitReply(sendText, { wabaId, phoneNumberId, waId }, body);
      if (outcome.sent) {
        setText("");
        onSent();
      } else {
        setNotice(outcome);
      }
    } finally {
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send();
  }

  // Enter goes through the form's own submit, so both paths share one send.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!isSendKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-busy={sending}
      className="flex flex-col gap-2 border-t border-(--line) px-4 py-3"
    >
      <p className={`m-0 ${LABEL}`}>{label}</p>
      <label htmlFor="conversation-reply" className="sr-only">
        Reply
      </label>
      <Textarea
        id="conversation-reply"
        value={text}
        disabled={sending}
        placeholder="Write a reply"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* Mounted even when empty: a live region that fills up is announced, one that appears with its message is not reliably. */}
        <output aria-live="polite" aria-atomic="true" className="min-w-0 flex-1 text-sm">
          {notice ? (
            <span className="block border-l-2 border-destructive px-3 py-1">
              <span className="block text-destructive-foreground">{notice.title}</span>
              <span className="block text-muted-foreground">{notice.detail}</span>
              {notice.secondary ? (
                <span className="mt-1 block font-mono text-xs break-words text-muted-foreground">
                  {notice.secondary}
                </span>
              ) : null}
            </span>
          ) : null}
        </output>
        <Button type="submit" disabled={sending || text.trim() === ""}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}

function TemplateOnlyReply({
  label,
  wabaId,
  waId,
  phoneNumberId,
  phones,
  onSent,
}: Pick<ConversationComposerProps, "wabaId" | "waId" | "phoneNumberId" | "phones"> & {
  label: string;
  onSent: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  return (
    <div className="flex flex-col gap-3 border-t border-(--line) px-4 py-3">
      <p className={`m-0 ${LABEL}`}>{label}</p>
      <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
        Free text needs a message from the customer in the last 24 hours. Send an approved template to reach them.
      </p>
      <Button type="button" className="w-fit self-start rounded-none" onClick={() => setChoosing(true)}>
        Send a template
      </Button>
      <SendTemplateSheet
        open={choosing}
        onOpenChange={setChoosing}
        wabaId={wabaId}
        waId={waId}
        phoneNumberId={phoneNumberId}
        phones={phones}
        onSent={onSent}
      />
    </div>
  );
}
