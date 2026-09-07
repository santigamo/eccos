import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { EMPTY_CELL } from "../../lib/logs";

/**
 * The pieces both log sheets are built from, shared rather than copied.
 *
 * The message sheet and the event sheet answer the same question from opposite
 * ends of one hop, so they read as one surface or they read as two products.
 * Two hand-maintained copies of a section header is how that drifts.
 *
 * The registers are the console's existing ones: `SECTION_LABEL` is the Inter
 * uppercase functional voice (never the pixel face — these are read on every
 * inspection), the fact rows are the `Field` anatomy from the Status page, the
 * message panel is the preview panel from `TemplatePreview`, and the
 * disclosure's shell is the ghost-control anatomy every other square control in
 * the console wears.
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

/**
 * A message as the recipient reads it — the send's own text, a customer's
 * reply, an echo.
 *
 * The same square muted panel `TemplatePreview` and the send sheet use for a
 * message body, so text that a phone rendered looks the same everywhere in the
 * console. Quiet and inert: `--ghost-fill` is the ghost CONTROL body and a
 * panel wearing it would read as something to click.
 */
export function MessagePanel({ children }: { children: string }) {
  return (
    <p className="m-0 border border-(--line) bg-muted p-3 text-sm whitespace-pre-wrap text-foreground">
      {children}
    </p>
  );
}

/**
 * ── WHERE A RAW PROVIDER PAYLOAD LIVES (data rule 10) ───────────────────────
 *
 * Both sheets used to open a section straight onto pretty-printed JSON, on a
 * console whose masthead says OPERATOR CONSOLE and which already refuses raw
 * server output on its failure screens (data rule 7). So the payload moved
 * behind a disclosure — and it MOVED, it was not deleted: when Meta answers
 * 132000 that body is the only thing that explains why, and taking it out
 * would push debugging into Cloudflare logs and leave the operator with
 * nothing to hand their developer.
 *
 * `<details>` rather than a component, and the overlay set stays closed by it:
 * a disclosure reveals content in place, it does not cover the page, so it is
 * not a fourth register. It is also keyboard-reachable and toggleable with no
 * script at all — `<summary>` is focusable and Enter-activated by the browser,
 * which is a stronger guarantee than any handler this file could write.
 *
 * `summary` is the CLAIM the payload backs ("exactly what your receiver got"),
 * because that claim is the reason an operator would ever open it.
 */
export function RawDisclosure({
  summary,
  json,
  note,
}: {
  summary: string;
  /** Pretty-printed by `prettyJson`, or the stored string back when it will not
   * parse. Scrolls inside itself so a long body never widens the sheet. */
  json: string;
  /** What the payload does NOT say on its own — the envelope it travelled in,
   * for instance. Rendered under it, inside the disclosure, because it only
   * qualifies the claim for a reader who opened the thing. */
  note?: ReactNode;
}) {
  return (
    <details className="group mt-3 border border-(--line-strong) bg-(--ghost-fill)">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground text-xs transition-colors",
          "hover:bg-(--ghost-fill-hover) hover:text-foreground",
          // The console's focus ring, never removed and never recolored — the
          // green comes from the base layer's `outline-ring/50` on `*`. Drawn
          // INSIDE the summary (negative offset) because the disclosure's own
          // border sits immediately outside it and the two would collide.
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:text-foreground",
          // Safari still paints the disclosure triangle through `list-none`.
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="text-[11px] font-medium tracking-wider uppercase">{summary}</span>
      </summary>
      <div className="border-t border-(--line) bg-muted">
        <pre className="m-0 max-h-80 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
          {json}
        </pre>
        {note ? <div className="px-3 pb-3 text-muted-foreground text-xs">{note}</div> : null}
      </div>
    </details>
  );
}
