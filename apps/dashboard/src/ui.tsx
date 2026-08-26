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
 * Landing tag anatomy: square, 1px edge, machine voice. Four families only —
 * anything unmapped falls back to the neutral "soon" tone.
 */
type StatusTone = "success" | "warning" | "destructive" | "neutral"

const STATUS_TONES: Record<string, StatusTone> = {
  healthy: "success",
  delivered: "success",
  sent: "success",
  approved: "success",
  degraded: "warning",
  pending: "warning",
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
        "inline-flex items-center border px-2 py-[3px] font-pixel text-[10px] leading-[1.1] tracking-[0.04em] uppercase",
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
}: {
  counts: Record<string, number>
  label: string
  /** Log view these counts are evidence for. */
  target: "deliveries" | "outbound"
}) {
  const entries = Object.entries(counts)
  if (entries.length === 0) {
    return (
      <p className="mt-3 text-muted-foreground text-sm">No {label} recorded yet.</p>
    )
  }
  return (
    <ul
      aria-label={`${label} by status`}
      className="mt-3 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0 font-pixel text-[11px] tracking-[0.04em] uppercase"
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
              <Link to="/deliveries" search={{ status }} className={className}>
                {body}
              </Link>
            ) : (
              <Link to="/outbound" className={className}>
                {body}
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Error card for the `{ ok: false }` (gateway unreachable / RPC threw) state. */
export function Unreachable({ error }: { error: string }) {
  return (
    <Frame variant="default" spacing="sm">
      <FramePanel fit>
        <FrameHeader>
          <FrameTitle>Gateway unreachable</FrameTitle>
          <FrameDescription>
            The dashboard could not reach the gateway over the <code className="text-foreground bg-muted px-1 text-xs">GATEWAY</code> service binding.
          </FrameDescription>
        </FrameHeader>
        <pre className="bg-destructive/10 text-destructive mt-2 overflow-auto border p-3 text-xs whitespace-pre-wrap break-words">
          {error}
        </pre>
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
            <span className="font-pixel text-[11px] tracking-[0.04em] uppercase text-muted-foreground">
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
