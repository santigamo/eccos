import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { retryFailedDeliveries } from "../../server/gateway";
import {
  defaultWindowInputs,
  readWindow,
  retryResultLines,
  submitRetryFailed,
  type RetryFailedNotice,
} from "../../lib/retry-window";
import { fmtTsShort } from "../../ui";

const LABEL = "mb-1 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
const HELP = "mt-1 m-0 max-w-prose text-xs text-pretty text-muted-foreground";
// The native picker is drawn by the browser, which paints it for a light page
// unless told otherwise: without this the calendar icon is dark on dark.
const DATE_TIME_INPUT = "[color-scheme:dark]";

/**
 * "Retry failed": the forwarding queue's one batch-shaped act at window scale.
 *
 * Register: a TASK sheet (docs/DASHBOARD-DESIGN.md, Overlays). The operator
 * composes a window, and the composition is the confirmation, so there is no
 * second "are you sure" stacked on a form they just filled in. What keeps the
 * act honest is what is on screen before the press: the sentence about
 * idempotency keys, and the exact UTC window the typed local times resolve to.
 *
 * Like the other sheets, the inner fields are exported on their own: a closed
 * Base UI dialog renders nothing, so a static render of `RetryFailedSheet`
 * would assert against an empty string.
 */

/** The window as the console writes every other instant: UTC, to the second.
 * The Enqueued column reads in UTC, so this is what lets an operator check a
 * window typed in local time against the rows it is meant to cover. */
export function describeWindow(window: { from: number; to: number }): string {
  return `${fmtTsShort(window.from)} to ${fmtTsShort(window.to)}`;
}

export interface RetryFailedFieldsProps {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  submitting: boolean;
  notice: RetryFailedNotice | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/**
 * The form itself. Fully controlled, like `CreateTemplateFields`, so every
 * state (a blocked window, a result, a refusal) renders without a browser.
 */
export function RetryFailedFields({
  from,
  to,
  onFromChange,
  onToChange,
  submitting,
  notice,
  onSubmit,
}: RetryFailedFieldsProps) {
  const reading = readWindow(from, to);

  return (
    <form onSubmit={onSubmit} aria-busy={submitting} className="flex flex-col gap-4 px-4 pb-4">
      <p className="m-0 max-w-prose text-sm text-pretty text-foreground/80">
        Sends every failed delivery enqueued in this window again. Each keeps its{" "}
        <code className="font-mono text-xs">x-idempotency-key</code>, so your receiver can drop
        repeats. Older events arrive late.
      </p>

      <div>
        <label htmlFor="retry-failed-from" className={LABEL}>
          From
        </label>
        <Input
          id="retry-failed-from"
          type="datetime-local"
          required
          className={DATE_TIME_INPUT}
          value={from}
          onChange={(event) => onFromChange(event.target.value)}
          aria-describedby="retry-failed-window"
        />
      </div>

      <div>
        <label htmlFor="retry-failed-to" className={LABEL}>
          To
        </label>
        <Input
          id="retry-failed-to"
          type="datetime-local"
          required
          className={DATE_TIME_INPUT}
          value={to}
          onChange={(event) => onToChange(event.target.value)}
          aria-describedby="retry-failed-window"
        />
      </div>

      {reading.ok ? (
        <p id="retry-failed-window" className={`${HELP} mt-0`}>
          Both are your local time, and the minute you pick is included. The Enqueued column shows
          UTC, so this window covers{" "}
          <span className="font-mono break-words">{describeWindow(reading.window)}</span>.
        </p>
      ) : (
        // The blocker sentence IS the reason the button is off, and it is on
        // screen rather than in a tooltip, which keeps a disabled button from
        // being a dead one (data rule 5).
        <p id="retry-failed-window" className="m-0 max-w-prose text-xs text-pretty text-[#ff7777]">
          {reading.reason}
        </p>
      )}

      <Button
        type="submit"
        className="w-fit self-start"
        aria-busy={submitting}
        disabled={submitting || !reading.ok}
      >
        {submitting ? "Retrying…" : "Retry failed deliveries"}
      </Button>

      {/* Mounted even when empty: a live region that appears with its message is
          not reliably announced, one that fills up is. */}
      <output
        aria-live="polite"
        aria-atomic="true"
        className={notice ? "block border-l-2 border-l-(--line-strong) px-3 py-2" : undefined}
      >
        {notice ? <NoticeBody notice={notice} /> : null}
      </output>
    </form>
  );
}

/** Exported so the result's wording is asserted directly. */
export function NoticeBody({ notice }: { notice: RetryFailedNotice }) {
  if (notice.ok) {
    const { headline, notes } = retryResultLines(notice);
    return (
      <span className="block">
        <span className="block text-sm text-foreground">{headline}</span>
        {notes.map((note) => (
          // Neutral, not amber: the operator cannot act on a row retention has
          // already emptied, and colour is for a state that asks for something.
          <span key={note} className="block text-sm text-muted-foreground">
            {note}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="block">
      <span className="block text-sm text-[#ff7777]">{notice.title}</span>
      <span className="block text-sm text-muted-foreground">{notice.detail}</span>
    </span>
  );
}

/**
 * The form with its state and its submit. It lives INSIDE the sheet's content,
 * which Base UI unmounts on close, so every opening starts from a fresh week
 * ending now instead of the last run's dates and result.
 */
export function RetryFailedForm({
  wabaId,
  onRetried,
  onBusyChange,
}: {
  wabaId: string;
  /** Called after a replay went through, so the route can re-read the queue. */
  onRetried?: () => Promise<unknown>;
  /** Tells the sheet around the form that a replay is in flight. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [initial] = useState(() => defaultWindowInputs(Date.now()));
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<RetryFailedNotice | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    onBusyChange?.(true);
    setNotice(null);
    try {
      const next = await submitRetryFailed(
        { wabaId, fromInput: from, toInput: to },
        retryFailedDeliveries,
      );
      setNotice(next);
      if (next.ok) await onRetried?.();
    } finally {
      setSubmitting(false);
      onBusyChange?.(false);
    }
  }

  return (
    <RetryFailedFields
      from={from}
      to={to}
      onFromChange={setFrom}
      onToChange={setTo}
      submitting={submitting}
      notice={notice}
      onSubmit={onSubmit}
    />
  );
}

/**
 * Must this close request be refused?
 *
 * Only Escape, and only while a replay is in flight: closing then throws away
 * the answer to an act that cannot be taken back. A press on the backdrop is
 * handled by `disablePointerDismissal`, and the close button is never refused,
 * so deliberate abandonment always stays possible.
 */
export function refusesClose(state: { submitting: boolean; reason: string }): boolean {
  return state.submitting && state.reason === "escape-key";
}

export function RetryFailedSheet({
  open,
  onOpenChange,
  wabaId,
  onRetried,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wabaId: string;
  onRetried?: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Sheet
      open={open}
      disablePointerDismissal={busy}
      onOpenChange={(next, details) => {
        if (!next && refusesClose({ submitting: busy, reason: details.reason })) {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
    >
      <SheetContent side="right" className="w-full gap-2 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-2">
          <SheetTitle className="text-sm">Retry failed deliveries</SheetTitle>
        </SheetHeader>
        <RetryFailedForm wabaId={wabaId} onRetried={onRetried} onBusyChange={setBusy} />
      </SheetContent>
    </Sheet>
  );
}
