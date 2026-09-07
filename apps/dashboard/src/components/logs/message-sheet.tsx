import { Link } from "@tanstack/react-router";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { GridEmptyState } from "../grid/empty-state";
import { FactRow, MessagePanel, RawDisclosure, SheetSection } from "./sheet-parts";
import type { OutboundRow, OutboundTrailEvent } from "../../server/gateway";
import { forwardReading } from "../../lib/forwarding";
import {
  EMPTY_CELL,
  messageSummary,
  messageSummaryText,
  prettyJson,
  requestReading,
} from "../../lib/logs";
import { COUNT_LINK, StatusTag, fmtTsShort } from "../../ui";

/**
 * ONE MESSAGE, HOP BY HOP — the console's forensic answer to "what happened to
 * the thing I sent".
 *
 * Three sections in the order the message travelled: the facts of the send,
 * what was actually in it, and what Meta reported back about it (the TRAIL).
 * Nothing here is a conversation view: the parser drops customer messages
 * without text and Meta's `sent` status is discarded, so a thread would have
 * holes that read as data loss. A hop list has no holes — every row is a
 * callback that actually arrived.
 *
 * WHAT WAS SENT IS A RECORD, NEVER A PREVIEW. `outbound_messages.request` holds
 * the Meta send body, so for a template it carries the name, the language and
 * the VALUES — and not one word of the template's own copy, which only ever
 * lived at Meta. The section therefore shows `{{1}} Ada`, labelled by slot.
 * Pouring those values into the template as it stands today would render a
 * message that was never sent, with the authority of a preview, every time a
 * template has been edited since — so the sheet LINKS to the template instead
 * and says out loud that the link is today's copy.
 *
 * The Meta body itself stays, one disclosure down: when Meta answers 132000 it
 * is the only thing that explains why, and it is what an operator hands their
 * developer.
 *
 * The Sheet register, per the overlay contract: this is a row inspected without
 * acting on it, so it docks beside the list and leaves it legible. Read-only by
 * construction — there is nothing to do to a message that has already been
 * sent.
 *
 * `MessageDetail` is exported separately because the sheet around it is a Base
 * UI dialog: closed, it renders nothing at all, so a static-markup test of the
 * sheet would assert against an empty string. Tests render the detail — the
 * same split as `TemplatePreview`.
 */

export interface MessageDetailProps {
  row: OutboundRow;
  hasForwardingTarget: boolean;
  /** The scope every link on the page carries. */
  wabaId?: string;
}

export function MessageDetail({ row, hasForwardingTarget, wabaId }: MessageDetailProps) {
  const trail = row.trail ?? [];
  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <SheetSection label="Facts">
        <dl className="m-0">
          <FactRow label="To" value={row.recipient} mono />
          <FactRow label="From number" value={row.phone_number_id ?? EMPTY_CELL} mono />
          <FactRow
            label="Sent at"
            value={<span title={String(row.created_at)}>{fmtTsShort(row.created_at)}</span>}
            mono
          />
          {/* The full wamid, once, where there is room for it — the log itself
              no longer prints 60 characters of base64 on every row. This is the
              id a developer pastes into a Meta support case, so it is never
              truncated here. */}
          <FactRow label="Meta message id" value={row.transport_message_id ?? EMPTY_CELL} mono />
          <FactRow label="Meta status" value={<StatusTag status={row.status} />} />
          {row.error ? <FactRow label="Error" value={row.error} tone="destructive" /> : null}
        </dl>
      </SheetSection>

      <SheetSection label="What was sent">
        <SentContent request={row.request} wabaId={wabaId} />
      </SheetSection>

      <SheetSection label="Trail">
        {trail.length === 0 ? (
          // Two different silences, and they are not the same fact. A refused
          // send never got a wamid, so no callback can ever be about it; an
          // accepted one with nothing back is simply still waiting.
          <p className="m-0 text-muted-foreground text-sm">
            {row.status === "failed"
              ? "Meta refused this send, so it has no message id and no status callback can be about it."
              : "Nothing has come back from Meta about this message yet."}
          </p>
        ) : (
          <ul className="m-0 list-none space-y-0 p-0">
            {trail.map((event) => (
              <TrailRow
                // A wamid carries at most one event per type (the gateway's
                // `uq_inbound_status` index enforces it), so the kind is a
                // stable key within one message's trail.
                key={event.type}
                event={event}
                hasForwardingTarget={hasForwardingTarget}
              />
            ))}
          </ul>
        )}
      </SheetSection>
    </div>
  );
}

/**
 * What the stored Meta body says, in words, with the body itself one
 * disclosure down.
 *
 * The branches that render no values each name a DIFFERENT silence, because
 * they are different facts: a body swept by retention, a body that will not
 * parse, a template send that filled no parameters, and a message kind the
 * console has no reading for. One shared "nothing to show" would tell an
 * operator that their `hello_world` send was somehow damaged.
 */
function SentContent({ request, wabaId }: { request: string; wabaId?: string }) {
  if (!request) {
    return (
      <p className="m-0 text-muted-foreground text-sm">
        The request body is past its retention window and has been removed.
      </p>
    );
  }
  const reading = requestReading(request);
  if (!reading) {
    return (
      <>
        <p className="m-0 text-muted-foreground text-sm">
          The stored request is not JSON, so there is nothing to read out of it. It is below
          exactly as it was stored.
        </p>
        <RawDisclosure summary="Request body, exactly as sent to Meta" json={prettyJson(request)} />
      </>
    );
  }
  const { template, text, values } = reading;
  return (
    <>
      {text ? <MessagePanel>{text}</MessagePanel> : null}

      {template || values.length > 0 ? (
        <dl className={text ? "mt-3 mb-0" : "m-0"}>
          {template ? (
            <>
              <FactRow label="Template" value={template.name ?? EMPTY_CELL} mono />
              <FactRow label="Language" value={template.language ?? EMPTY_CELL} mono />
            </>
          ) : null}
          {values.map((value) => (
            // The slot is the identity: a template never has two `{{1}}`, and a
            // media send never has two links. No index key is needed and none
            // would survive a body that grew a parameter.
            <FactRow key={value.slot} label={value.slot} value={value.value} mono={value.mono} />
          ))}
        </dl>
      ) : null}

      {!text && values.length === 0 ? (
        <p className="m-0 text-muted-foreground text-sm">
          {reading.kind === "template"
            ? "This send filled no parameters — every word in it is the template's own copy."
            : `The console has no reading for a ${reading.kind} send. What went to Meta is below.`}
        </p>
      ) : null}

      {template?.name ? (
        <p className="mt-3 mb-0 text-muted-foreground text-xs">
          {/* A door, deliberately NOT a preview. The values above are what was
              sent; the template is a living thing that may have been edited or
              deleted since, so the link is labelled for what it leads to and
              nothing is drawn from it here. */}
          <Link
            to="/templates"
            search={wabaId ? { wabaId } : {}}
            className={`text-primary ${COUNT_LINK}`}
          >
            Open {template.name} in Templates
          </Link>{" "}
          — the template as it stands now, not what this message carried.
        </p>
      ) : null}

      {/* The Meta body AS SENT, not a reconstruction: the exact JSON the gateway
          posted, which is what makes a parameter-mismatch argument with Meta
          settleable. */}
      <RawDisclosure summary="Request body, exactly as sent to Meta" json={prettyJson(request)} />
    </>
  );
}

/** One callback in the trail: what Meta said, when, and what Eccos did with it. */
function TrailRow({
  event,
  hasForwardingTarget,
}: {
  event: OutboundTrailEvent;
  hasForwardingTarget: boolean;
}) {
  const forward = forwardReading({
    status: event.deliveryStatus,
    attempts: event.deliveryAttempts,
    hasForwardingTarget,
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-(--line) py-2 last:border-b-0">
      <span className="flex items-baseline gap-2">
        {/* Ink weight, not colour: `failed` is the one kind an operator has to
            act on, so it is the one that spends red (data rule 1). */}
        <span
          className={
            event.type === "failed" ? "text-destructive-foreground text-sm" : "text-foreground text-sm"
          }
        >
          {event.type}
        </span>
        {event.errorCode ? (
          <span className="font-mono text-destructive-foreground text-xs">{event.errorCode}</span>
        ) : null}
      </span>
      <span className="flex items-center gap-3">
        <span className="font-mono text-muted-foreground text-xs" title={String(event.at)}>
          {fmtTsShort(event.at)}
        </span>
        {/* The forward state of the batch that carried THIS event — the second
            hop, named in its own vocabulary so `delivered` above (Meta → phone)
            and `forwarded` here (Eccos → subscriber) can never be confused. */}
        {forward ? <StatusTag status={forward.label} /> : <span className="text-muted-foreground">{EMPTY_CELL}</span>}
      </span>
    </li>
  );
}

export function MessageSheet({
  open,
  onOpenChange,
  row,
  ...detail
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` when the address in the URL names a message that is not on this
   * page — a pasted link into an older row. */
  row: OutboundRow | null;
} & Omit<MessageDetailProps, "row">) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-2 overflow-y-auto sm:max-w-lg">
        <SheetHeader className="gap-2">
          <SheetTitle className="font-mono text-sm break-all">
            {row ? messageSummaryText(messageSummary(row.id, row.request)) : "Message"}
          </SheetTitle>
        </SheetHeader>
        {row ? (
          <MessageDetail row={row} {...detail} />
        ) : (
          <div className="px-4 pb-4">
            <GridEmptyState
              label="NOT IN THIS VIEW"
              description="This message is older than the rows on this page. Load older messages to reach it."
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
