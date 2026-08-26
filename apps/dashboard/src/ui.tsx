import type { ReactNode } from "react"
import type { VariantProps } from "class-variance-authority"

import { Badge, type badgeVariants } from "@/components/reui/badge"
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

type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  healthy: "success-light",
  delivered: "success-light",
  sent: "success-light",
  approved: "success-light",
  degraded: "warning-light",
  pending: "warning-light",
  unhealthy: "destructive-light",
  failed: "destructive-light",
  rejected: "destructive-light",
};

/** Colored status label; unknown statuses render in the neutral secondary tone. */
export function StatusTag({ status }: { status: string }) {
  const variant = STATUS_VARIANTS[status.toLowerCase()] ?? "secondary";
  return (
    <Badge variant={variant} size="sm" radius="default" className="uppercase">
      {status}
    </Badge>
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
