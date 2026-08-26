import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame"

/** Format an epoch-ms timestamp as an ISO string, tolerating null / garbage. */
export function fmtTs(ms: number | string | null | undefined): string {
  if (ms == null || ms === "") return "\u2014"
  const n = Number(ms)
  if (!Number.isFinite(n)) return "\u2014"
  return new Date(n).toISOString()
}

const STATUS_TONES: Record<string, string> = {
  healthy: "text-success",
  delivered: "text-success",
  sent: "text-success",
  approved: "text-success",
  degraded: "text-warning",
  pending: "text-warning",
  unhealthy: "text-destructive-foreground",
  failed: "text-destructive-foreground",
  rejected: "text-destructive-foreground",
}

/** Colored status label; unknown statuses render in the neutral text color. */
export function StatusTag({ status }: { status: string }) {
  const tone = STATUS_TONES[status.toLowerCase()] ?? "text-muted-foreground"
  return (
    <span className={cn("font-pixel text-xs tracking-wider uppercase", tone)}>
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
            <td className="py-1.5 pl-2 text-right font-semibold tabular-nums border-b border-(--frame-panel-border-color)">{n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Error card for the `{ ok: false }` (gateway unreachable / RPC threw) state. */
export function Unreachable({ error }: { error: string }) {
  return (
    <Frame variant="ghost">
      <FramePanel>
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

/** Page shell: title + optional right-aligned controls, then children. */
export function Page({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <Frame variant="ghost" spacing="sm">
      <FramePanel>
        <FrameHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <FrameTitle className="font-pixel text-xs tracking-widest uppercase">{title}</FrameTitle>
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
        </FrameHeader>
        {children}
      </FramePanel>
    </Frame>
  )
}

export const styles = {
  tableWrap:
    "-mx-(--frame-panel-px) -mb-(--frame-panel-py) overflow-x-auto border-t border-(--frame-panel-border-color)",
  table: "w-full border-collapse text-sm",
  th: "text-left px-4 py-2 text-[11px] font-pixel text-muted-foreground tracking-wider uppercase border-b border-(--frame-panel-border-color) whitespace-nowrap",
  td: "px-4 py-2.5 border-b border-(--frame-panel-border-color) text-foreground/80 align-top",
  tdMono: "px-4 py-2.5 border-b border-(--frame-panel-border-color) text-foreground align-top font-mono text-xs break-all",
  tdNum: "px-4 py-2.5 border-b border-(--frame-panel-border-color) text-foreground text-right align-top font-mono text-xs tabular-nums",
  empty: "px-4 py-6 text-muted-foreground text-sm text-center",
  muted: "text-muted-foreground text-sm",
  code: "bg-muted text-foreground px-1 text-xs",
  errorBox:
    "bg-destructive/10 text-destructive mt-2 overflow-auto border border-destructive/20 p-3 text-xs whitespace-pre-wrap break-words",
  button:
    "inline-flex items-center justify-center h-7 px-3 text-xs font-medium border border-border bg-transparent hover:bg-accent text-foreground transition-colors",
  select:
    "inline-flex items-center justify-center h-7 px-2 text-xs font-medium border border-border bg-transparent text-foreground transition-colors",
  input:
    "block w-full h-8 px-2 text-sm border border-border bg-transparent text-foreground transition-colors",
  label:
    "block mb-1 text-[11px] font-pixel text-muted-foreground tracking-wider uppercase",
  formRow: "mb-3",
  hint: "mt-1 text-muted-foreground text-xs",
  success:
    "bg-success/10 text-success mt-2 overflow-auto border border-success/20 p-3 text-xs whitespace-pre-wrap break-words",
  card:
    "border border-border bg-card",
  cardTitle:
    "text-[11px] font-pixel text-muted-foreground tracking-wider uppercase mb-2",
  dl: "m-0 divide-y divide-(--frame-panel-border-color)",
  field: "flex justify-between gap-4 py-2",
  fieldLabel: "text-muted-foreground text-sm",
  fieldValue: "text-foreground text-sm text-right break-all",
  grid: "grid grid-cols-1 sm:grid-cols-3 gap-4",
  bigNumber: "m-0 text-3xl font-bold text-foreground tabular-nums",
  footer: "mt-6 text-muted-foreground text-xs text-center",
  badge: "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium",
  dot: "size-1.5 shrink-0",
} as const
