import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { EMPTY_CELL } from "../../lib/logs";

/**
 * The three pieces both log sheets are built from, shared rather than copied.
 *
 * The message sheet and the event sheet answer the same question from opposite
 * ends of one hop, so they read as one surface or they read as two products.
 * Two hand-maintained copies of a section header is how that drifts.
 *
 * The registers are the console's existing ones: `SECTION_LABEL` is the Inter
 * uppercase functional voice (never the pixel face — these are read on every
 * inspection), the fact rows are the `Field` anatomy from the Status page, and
 * the JSON block is the `<pre>` idiom from `Unreachable`.
 */

const SECTION_LABEL =
  "mb-2 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase";

export function SheetSection({
  label,
  action,
  children,
}: {
  label: string;
  /** A control that belongs to this section and nowhere else — the batch's
   * Retry, the door to the message. Never a second primary. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-(--line) pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className={SECTION_LABEL}>{label}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * One labelled fact. `mono` is for values an operator COPIES rather than reads —
 * a wamid, a phone number, a timestamp — where character shapes have to be
 * unambiguous; prose values stay in Inter.
 */
export function FactRow({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  /** `destructive` is the only tone a fact may take, and only for a real error
   * string (data rule 1). */
  tone?: "destructive";
}) {
  return (
    <div className="flex justify-between gap-4 border-b border-(--line) py-2 last:border-b-0">
      <dt className="shrink-0 text-muted-foreground text-sm">{label}</dt>
      <dd
        className={cn(
          "m-0 min-w-0 text-right text-sm break-all",
          mono && "font-mono text-xs",
          tone === "destructive" ? "text-destructive-foreground" : "text-foreground",
        )}
      >
        {value ?? EMPTY_CELL}
      </dd>
    </div>
  );
}

/** A block of stored JSON, exactly as stored. Scrolls inside itself so a long
 * body never widens the sheet. */
export function JsonBlock({ children }: { children: string }) {
  return (
    <pre className="m-0 max-h-80 overflow-auto border border-(--line) bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
      {children}
    </pre>
  );
}
