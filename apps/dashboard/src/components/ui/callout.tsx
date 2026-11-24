import { OctagonXIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A heads-up (amber) or a problem (red), with the same glyphs as the toasts. */
const TONES = {
  warning: {
    frame: "border-l-warning bg-warning/12 text-foreground",
    icon: <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-foreground" />,
  },
  error: {
    frame: "border-l-destructive bg-destructive/12 text-destructive-foreground",
    icon: <OctagonXIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />,
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
    <div className={cn("flex items-start gap-2 border-l-2 px-3 py-2 text-sm text-pretty", TONES[tone].frame, className)}>
      {TONES[tone].icon}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
