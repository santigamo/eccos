import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { GridEmptyState } from "../grid/empty-state";
import { FactRow, MessagePanel, RawDisclosure, SheetSection } from "./sheet-parts";
import type { InboundRow } from "../../server/gateway";
import { FORWARD_MAX_ATTEMPTS, deliveryMoment, forwardReading } from "../../lib/forwarding";
import {
  EMPTY_CELL,
  eventReading,
  messageRefText,
  messageSummary,
  prettyJson,
  wamidTail,
} from "../../lib/logs";
import { StatusTag, fmtTsShort } from "../../ui";

/**
 * ONE EVENT, AND WHAT THE RECEIVER GOT.
 *
 * The middle section says what the event ACTUALLY CARRIES, which is a short
 * list and always was: a reply or an echo has a party and a text, a status has
 * a message reference and Meta's own moment, a failure has a code and Meta's
 * sentence about it. All of that used to be legible only by reading JSON on a
 * console whose masthead says OPERATOR CONSOLE.
 *
 * The event JSON is still here, one disclosure down, and it is still the single
 * most valuable thing this console can show a DEVELOPER: byte for byte what
 * Eccos POSTed inside the batch envelope. Every argument about an integration
 * ends there — "my handler never saw the text" is answered by the text being in
 * the payload or not, not by a summary the console composed. That claim is why
 * the disclosure exists, so the claim is what its summary says.
 *
 * Below it, the forwarding state of the batch this event rode in, in the
 * forward hop's own vocabulary (`lib/forwarding.ts`): `held` is not `pending`,
 * `forwarded` is not `delivered`, and the moment is NAMED rather than printed
 * under a header that guesses which moment it is.
 *
 * Sheet register, and it carries exactly one act: Retry, on a failed batch.
 * That is the same act the row offers, placed where the operator has just read
 * the evidence for it — sending them back out to the row to press it would be
 * the interruption the register exists to avoid. Nothing else here writes.
 *
 * `EventDetail` is exported on its own for the same reason as
 * `TemplatePreview`: a closed Base UI dialog renders nothing, so a static
 * markup test asserts against the inner block.
 */

export interface EventDetailProps {
  row: InboundRow;
  hasForwardingTarget: boolean;
  /** The scope every link on the page carries. */
  wabaId?: string;
  /** Re-enqueue the batch. Present only when it is `failed`; absent otherwise,
   * so the section renders no dead control (data rule 5). */
  onRetry?: () => void;
  retrying?: boolean;
}

export function EventDetail({ row, hasForwardingTarget, wabaId, onRetry, retrying }: EventDetailProps) {
  const reading = eventReading(row.type, row.payload);
  const forward = forwardReading({
    status: row.delivery_status,
    attempts: row.delivery_attempts,
    hasForwardingTarget,
  });
  const moment =
    row.delivery_status == null
      ? null
      : deliveryMoment(
          {
            status: row.delivery_status,
            finished_at: row.delivery_finished_at ?? null,
            next_attempt_at: row.delivery_next_attempt_at ?? 0,
          },
          hasForwardingTarget,
        );
  const others = (row.delivery_event_count ?? 1) - 1;
  const message =
    row.outbound_id != null ? messageSummary(row.outbound_id, row.outbound_request ?? "") : null;

  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <SheetSection label="Facts">
        <dl className="m-0">
          {/* TWO MOMENTS, NAMED. `at` is Meta's own timestamp — when the phone
              got it, when it was read, when the customer wrote — and
              `received_at` is when the callback reached Eccos. They differ by
              the callback's flight time, and the first is the one an operator
              compares against a customer's screenshot, so the sheet shows both
              rather than picking one and heading it "time". */}
          {reading.at !== null ? (
            <FactRow
              label="Happened at"
              value={<span title={String(reading.at)}>{fmtTsShort(reading.at)}</span>}
              mono
            />
          ) : null}
          <FactRow
            label="Received"
            value={<span title={String(row.received_at)}>{fmtTsShort(row.received_at)}</span>}
            mono
          />
          <FactRow label="Kind" value={reading.kind} />
          {reading.party ? (
            <FactRow
              label={reading.party.direction === "from" ? "From" : "To"}
              value={`+${reading.party.phone}`}
              mono
            />
          ) : null}
          <FactRow label="Number" value={row.phone_number_id ?? EMPTY_CELL} mono />
          {/* A status event names a wamid; a reply or an echo names its own
              message id. Both are shown in full and both are labelled for what
              they are — the old log printed one of them under "Summary". */}
          {row.transport_message_id ? (
            <FactRow label="About message id" value={row.transport_message_id} mono />
          ) : null}
          {row.message_id ? <FactRow label="Message id" value={row.message_id} mono /> : null}
        </dl>
      </SheetSection>

      <SheetSection label="What arrived">
        {reading.text ? <MessagePanel>{reading.text}</MessagePanel> : null}

        {reading.errorCode || reading.errorMessage ? (
          <dl className="m-0">
            {/* Meta's code first, because that is what an operator searches for
                and quotes in a support case; Meta's sentence beside it, marked
                as Meta's in the section's own words rather than restated as if
                the console had diagnosed anything (data rule 7). */}
            <FactRow label="Error code" value={reading.errorCode ?? EMPTY_CELL} mono tone="destructive" />
            {reading.errorMessage ? (
              <FactRow label="Meta says" value={reading.errorMessage} tone="destructive" />
            ) : null}
          </dl>
        ) : null}

        {!reading.text && !reading.errorCode && !reading.errorMessage ? (
          // A receipt with nothing in it is not a gap, and saying so beats an
          // empty section that reads as a parse failure. Grounded in what the
          // ROW carries rather than in the kind's name: an event type the
          // parser learns to emit later would otherwise inherit a sentence
          // about receipts that nobody checked.
          <p className="m-0 text-muted-foreground text-sm">
            {row.transport_message_id
              ? `A ${reading.kind} event carries no text — it reports on the message it names.`
              : "This event carries no text. What your receiver got is below."}
          </p>
        ) : null}

        <RawDisclosure
          summary="Event JSON, exactly what your receiver got"
          json={prettyJson(row.payload)}
          note={
            others > 0
              ? `Sent inside {"events":[…]} with ${others} other ${others === 1 ? "event" : "events"}.`
              : 'Sent inside {"events":[…]} as the only event in its batch.'
          }
        />
      </SheetSection>

      <SheetSection
        label="Forwarding"
        action={
          onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-none"
              disabled={retrying}
              onClick={onRetry}
              aria-label={`Retry batch ${row.delivery_id ?? ""}`}
            >
              {retrying ? "…" : "Retry"}
            </Button>
          ) : null
        }
      >
        {forward === null ? (
          // No batch to describe. Never invent one: an event ingested before
          // the event→batch link existed, or one whose batch has aged out of
          // the delivery-audit window, genuinely has no forwarding record.
          <p className="m-0 text-muted-foreground text-sm">
            No forwarding batch is recorded for this event.
          </p>
        ) : (
          <dl className="m-0">
            <FactRow label="Batch" value={`#${row.delivery_id}`} mono />
            <FactRow label="State" value={<StatusTag status={forward.label} />} />
            <FactRow
              label="Attempts"
              value={`${row.delivery_attempts ?? 0} of ${FORWARD_MAX_ATTEMPTS}`}
              mono
            />
            {moment ? (
              <FactRow
                label={MOMENT_LABEL[moment.label]}
                // A held batch has no next time and the console does not invent
                // one: the label IS the answer.
                value={moment.at === null ? EMPTY_CELL : fmtTsShort(moment.at)}
                mono
              />
            ) : null}
            {row.delivery_last_error ? (
              <FactRow label="Last error" value={row.delivery_last_error} tone="destructive" />
            ) : null}
          </dl>
        )}
      </SheetSection>

      {message ? (
        <SheetSection label="Message">
          <p className="m-0 text-sm">
            {/* Data rule 2 across logs, which is the join that did not exist:
                the wamid was printed in full on the event log and on the
                message log and was a door on neither. */}
            <Link
              to="/messages"
              search={{ message: row.outbound_id ?? undefined, ...(wabaId ? { wabaId } : {}) }}
              className="text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Open message {messageRefText(message)}
            </Link>
          </p>
        </SheetSection>
      ) : row.transport_message_id ? (
        <SheetSection label="Message">
          <p className="m-0 text-muted-foreground text-sm">
            No message in this workspace matches{" "}
            <span className="font-mono text-xs">{wamidTail(row.transport_message_id)}</span> — it was
            sent from outside Eccos, or it is past its retention window.
          </p>
        </SheetSection>
      ) : null}
    </div>
  );
}

/** What the batch's one timestamp IS. `unknown` gets a neutral noun because the
 * console knows the batch finished and does not know when. */
const MOMENT_LABEL: Record<"finished" | "next" | "held" | "unknown", string> = {
  finished: "Finished",
  next: "Next attempt",
  held: "Held since",
  unknown: "Finished at",
};

export function EventSheet({
  open,
  onOpenChange,
  row,
  ...detail
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` when the address in the URL names an event that is not on this page. */
  row: InboundRow | null;
} & Omit<EventDetailProps, "row">) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-2 overflow-y-auto sm:max-w-lg">
        <SheetHeader className="gap-2">
          <SheetTitle className="text-sm break-all">
            {row ? `${row.type} · event #${row.id}` : "Event"}
          </SheetTitle>
        </SheetHeader>
        {row ? (
          <EventDetail row={row} {...detail} />
        ) : (
          <div className="px-4 pb-4">
            <GridEmptyState
              label="NOT IN THIS VIEW"
              description="This event is older than the rows on this page. Load older events to reach it."
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
