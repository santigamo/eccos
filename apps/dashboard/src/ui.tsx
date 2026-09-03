import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame"
import { cn } from "@/lib/utils"

/** Format an epoch-ms timestamp as an ISO string, tolerating null / garbage. */
export function fmtTs(ms: number | string | null | undefined): string {
  if (ms == null || ms === "") return "\u2014"
  const n = Number(ms)
  if (!Number.isFinite(n)) return "\u2014"
  return new Date(n).toISOString()
}

/**
 * The same instant, minus the milliseconds and the `T`, for prose and for
 * facts cells where a full ISO string is a wall of punctuation.
 *
 * Still EXACT and still UTC — the console never shows a relative time on its
 * own (data rule: no relative-only timestamps on evidence), and it never
 * localizes one either, because an operator comparing a console reading against
 * a log line needs the two to be the same string. The full ISO value goes on
 * `title` wherever this is used.
 */
export function fmtTsShort(ms: number | string | null | undefined): string {
  const iso = fmtTs(ms)
  if (iso === "—") return iso
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

/**
 * Landing tag anatomy: square, 1px edge, machine voice. Four families only —
 * anything unmapped falls back to the neutral "soon" tone.
 */
type StatusTone = "success" | "warning" | "destructive" | "neutral"

const STATUS_TONES: Record<string, StatusTone> = {
  healthy: "success",
  active: "success",
  delivered: "success",
  sent: "success",
  approved: "success",
  // The Webhooks page's own two states. `forwarding` is a FACT, not a switch:
  // Eccos has no pause semantics, and a tag that reads as a toggle but is not
  // one lies about the interaction contract.
  forwarding: "success",
  degraded: "warning",
  pending: "warning",
  "no target": "warning",
  unhealthy: "destructive",
  unreachable: "destructive",
  failed: "destructive",
  rejected: "destructive",
}

const TONE_CLASSES: Record<StatusTone, string> = {
  success:
    "bg-(--tag-live-bg) text-(color:--tag-live-ink) border-(--tag-live-edge)",
  warning: "bg-[rgba(240,160,32,.12)] text-[#f0a020] border-[rgba(240,160,32,.3)]",
  destructive:
    "bg-[rgba(224,49,49,.12)] text-[#ff7777] border-[rgba(224,49,49,.3)]",
  neutral: "bg-(--tag-soon-bg) text-muted-foreground border-(--line-strong)",
}

/** Colored status label; unknown statuses render in the neutral tone. */
export function StatusTag({ status }: { status: string }) {
  const tone = STATUS_TONES[status.toLowerCase()] ?? "neutral"
  return (
    <span
      className={cn(
        "inline-flex items-center border px-2 py-[3px] text-[11px] leading-[1.1] font-medium tracking-wider uppercase",
        TONE_CLASSES[tone]
      )}
    >
      {status}
    </span>
  )
}

/**
 * Ink for a count entry. Colour is spent only on states an operator has to act
 * on, so the exceptions carry; everything else stays muted.
 */
const COUNT_INK: Record<string, string> = {
  failed: "text-[#ff7777]",
  rejected: "text-[#ff7777]",
  unhealthy: "text-[#ff7777]",
  pending: "text-[#f0a020]",
  degraded: "text-[#f0a020]",
}

/** Quiet at rest, underlined on hover — a count that admits it is a door. */
export const COUNT_LINK =
  "underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"

/** Sum of a per-status count map — the headline number of a facts cell. */
export function countTotal(counts: Record<string, number>): number {
  let total = 0
  for (const n of Object.values(counts)) total += n
  return total
}

/**
 * One machine-voice row of per-status counts, each linking into the log view
 * that holds the rows behind the number.
 */
export function StatusCounts({
  counts,
  label,
  target,
  wabaId,
}: {
  counts: Record<string, number>
  label: string
  /** Log view these counts are evidence for. */
  target: "deliveries" | "outbound"
  wabaId?: string
}) {
  const entries = Object.entries(counts)
  if (entries.length === 0) {
    return (
      <p className="mt-3 text-muted-foreground text-sm">No {label} recorded yet.</p>
    )
  }
  const search = wabaId ? { wabaId } : undefined
  return (
    <ul
      aria-label={`${label} by status`}
      className="mt-3 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0 text-[11px] font-medium tracking-wider uppercase"
    >
      {entries.map(([status, n], i) => {
        const className = cn(
          COUNT_LINK,
          COUNT_INK[status.toLowerCase()] ??
            "text-muted-foreground hover:text-foreground",
        )
        const body = (
          <>
            {status} <span className="tabular-nums">{n}</span>
          </>
        )
        return (
          <li key={status} className="flex items-center gap-2">
            {i > 0 ? (
              <span aria-hidden="true" className="text-muted-foreground/50">
                ·
              </span>
            ) : null}
            {target === "deliveries" ? (
              <Link to="/deliveries" search={{ status, ...search }} className={className}>
                {body}
              </Link>
            ) : (
              <Link to="/outbound" search={search} className={className}>
                {body}
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The landing's facts strip (data rule 3): no boxes, no shadows — cells that
 * share the page's rules and rails, so the figures sit in the structure instead
 * of floating above it.
 *
 * Shared rather than copied: /` and /webhooks both open with one, and two hand-
 * maintained copies of a house idiom are how a system drifts into two systems.
 */
export function FactsStrip({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={label}
      className="grid grid-cols-1 divide-y divide-(--line) border-y border-(--line) sm:grid-cols-3 sm:divide-x sm:divide-y-0"
    >
      {children}
    </section>
  )
}

/**
 * One cell of a facts strip.
 *
 * `caption` is hidden from assistive tech on purpose: the value above it
 * already carries the caption in its accessible name, so a screen reader hears
 * it once.
 *
 * `scale` exists because not every datum is a number. A count gets the big
 * pixel face; a short word (`DELIVERED`, `NO SECRET`) gets a smaller one —
 * eight pixel-face characters at `text-4xl` do not fit a third of the row, and
 * a pixel face that has to shrink below its 12px floor to fit would blur.
 */
export function FactCell({
  kicker,
  value,
  caption,
  scale = "number",
  children,
}: {
  kicker: string
  value: ReactNode
  caption: string
  scale?: "number" | "word"
  children?: ReactNode
}) {
  return (
    <div className="p-5">
      <p className="font-pixel text-xs tracking-[0.04em] uppercase text-muted-foreground">
        {kicker}
      </p>
      <p
        className={cn(
          "mt-2 font-pixel tabular-nums text-foreground",
          scale === "number" ? "text-4xl" : "text-2xl uppercase",
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-muted-foreground text-sm" aria-hidden="true">
        {caption}
      </p>
      {children}
    </div>
  )
}

/**
 * Error card for a transport or RPC failure — and ONLY for that.
 *
 * This copy asserts a specific cause, so it may only render for
 * `kind: "unreachable"`, the one failure class where the console has
 * established that the gateway is the problem. Authorization refusals happen
 * before any RPC is attempted and render as themselves through
 * `components/dashboard/failure.tsx`; route it through `FailureView` rather
 * than reaching for this card directly (eccos-k5a).
 */
export function Unreachable({ error }: { error: string }) {
  return (
    <Frame variant="default" spacing="sm" className="max-w-2xl">
      <FramePanel fit>
        <FrameHeader>
          <FrameTitle>Gateway unreachable</FrameTitle>
          <FrameDescription>
            The dashboard could not reach the gateway over the <code className="text-foreground bg-muted px-1 text-xs">GATEWAY</code> service binding.
          </FrameDescription>
        </FrameHeader>
        <pre className="mt-2 overflow-auto rounded-(--frame-radius) border border-(--frame-panel-border-color) bg-muted/40 p-3 text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {error}
        </pre>
        <p className="text-muted-foreground text-xs">
          If this persists, check that the gateway Worker is deployed and the
          service binding points at it, then reload the page.
        </p>
      </FramePanel>
    </Frame>
  )
}

/**
 * Page shell — the landing's chapter opening translated to a route:
 * pixel kicker + big light Inter heading on bare background, a hatch band
 * as the divider, then the content region. No outer panel: sections below
 * carry their own edges, so the page reads as structure, not as a card.
 */
export function Page({
  title,
  kicker = "Operator console",
  actions,
  children,
}: {
  title: string
  kicker?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          {kicker ? (
            <span className="font-pixel text-xs tracking-[0.04em] uppercase text-muted-foreground">
              {kicker}
            </span>
          ) : null}
          <h1 className="text-[1.75rem] font-normal tracking-[-0.012em] leading-[1.16] text-foreground [font-variation-settings:'opsz'_32]">
            {title}
          </h1>
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2 pb-1">{actions}</div>
        ) : null}
      </header>
      <div className="hatch-band" aria-hidden="true" />
      <div className="flex min-h-0 flex-1 flex-col pt-6">{children}</div>
    </div>
  )
}
