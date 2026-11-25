import { CopyIcon, OctagonXIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "../dashboard/copy-button";
import { cn } from "@/lib/utils";

/** A heads-up (amber) or a problem (red): open text on a 2px rail, no box. */
const TONES = {
  warning: {
    frame: "border-l-warning text-foreground",
    icon: <TriangleAlertIcon aria-hidden="true" className="size-3.5 text-warning-foreground" />,
  },
  error: {
    frame: "border-l-destructive text-destructive-foreground",
    icon: <OctagonXIcon aria-hidden="true" className="size-3.5" />,
  },
};

export function Callout({
  tone,
  className,
  children,
}: {
  tone: keyof typeof TONES;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-2 border-l-2 py-0.5 pl-4 text-sm text-pretty", TONES[tone].frame, className)}>
      <span className="flex h-5 shrink-0 items-center">{TONES[tone].icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** An error Meta reported: status, what happened, what to do, and Meta's references to copy. */
export function ErrorReport({
  status,
  title,
  body,
  refs,
  labels,
}: {
  status: string;
  title: string;
  body: string;
  refs: string;
  labels: { copy: string; copied: string; failed: string };
}) {
  return (
    <div className="flex flex-col gap-4 border-l-2 border-l-destructive py-0.5 pl-5">
      <div className="flex flex-col gap-2">
        <p className="m-0 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-destructive-foreground uppercase">
          <OctagonXIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {status}
        </p>
        <p className="m-0 text-lg leading-6 font-semibold tracking-[-0.01em] text-foreground">{title}</p>
        <p className="m-0 text-sm text-pretty text-muted-foreground">{body}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-xs text-muted-foreground">{refs}</span>
        <CopyButton
          key={refs}
          value={refs}
          labels={labels}
          icon={<CopyIcon aria-hidden="true" className="size-3" />}
          variant="link"
          className="h-auto gap-1.5 p-0 text-foreground underline decoration-1 underline-offset-3"
        />
      </div>
    </div>
  );
}
