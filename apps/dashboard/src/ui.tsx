import type { ReactNode } from "react"

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

export function CountTable({
  counts,
  label,
}: {
  counts: Record<string, number>;
  label: string;
}) {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">No {label} recorded yet.</p>;
  }
  return (
    <table aria-label={`${label} by status`} className="w-full border-collapse">
      <thead className="sr-only">
        <tr>
          <th>Status</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([status, n]) => (
          <tr key={status}>
            <td className="py-1.5 pr-2 text-foreground/80 text-sm border-b border-(--frame-panel-border-color)">{status}</td>
            <td className="py-1.5 pl-2 text-right font-pixel tabular-nums text-foreground border-b border-(--frame-panel-border-color)">{n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
