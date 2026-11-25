import { useEffect, useState } from "react";
import { ClockIcon } from "lucide-react";
import { useHydrated } from "../../hooks/use-hydrated";
import { startCheckout } from "../../server/gateway";
import { earlyAccessEnding, earlyAccessMessage, timeLeft, weekdayTime, windowOpen, windowPhase, type SetupWindow } from "../../lib/setup-window";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useBillingRedirect } from "./billing-redirect";

/** What the strip says after the countdown. No extension is offered: the window cannot be made longer. */
export function stripMessage(pausesAt: number, now: number, local = false): string {
  const phase = windowPhase(pausesAt - now);
  if (phase === "hour") return "Subscribe now to avoid a pause.";
  if (phase === "day") return `Sending and forwarding pause on ${weekdayTime(pausesAt, local)}.`;
  return `Sending and forwarding pause on ${weekdayTime(pausesAt, local)} unless you subscribe.`;
}

/**
 * The quiet bar under the masthead while an activated workspace has not paid:
 * neutral until a day is left, amber after. Renders nothing without the
 * gateway's timers (eccos-dbb3.2) or once the window has closed.
 */
export function SetupWindowStrip({ window, canManage, now: initial }: { window: SetupWindow; canManage: boolean; now?: number }) {
  const [now, setNow] = useState(() => initial ?? Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const { busy, leaveTo } = useBillingRedirect();
  const local = useHydrated();
  const early = earlyAccessEnding(window, now);
  if (!early && !windowOpen(window, now)) return null;
  const pausesAt = window.pausesAt as number;
  const warn = windowPhase(pausesAt - now) !== "neutral";
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-(--line) bg-muted py-1.5 pr-4 md:pr-6",
        warn ? "border-l-2 border-l-warning pl-3.5 md:pl-5.5" : "pl-4 md:pl-6",
      )}
    >
      <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <ClockIcon aria-hidden="true" className={cn("size-3.5 shrink-0", warn ? "text-warning" : "text-muted-foreground")} />
        <span className="text-[11px] leading-3.5 font-medium tracking-[0.08em] text-muted-foreground uppercase">{early ? "Early access" : "Setup window"}</span>
        {early ? null : (
          <span className={cn("font-mono text-xs font-medium", warn ? "text-warning-foreground" : "text-foreground")}>
            {timeLeft(pausesAt - now)}
          </span>
        )}
        <span className={cn("text-[13px] leading-4.5", warn ? "text-foreground" : "text-muted-foreground")}>
          {early ? earlyAccessMessage(pausesAt, now) : stripMessage(pausesAt, now, local)}
        </span>
      </p>
      {canManage ? (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void leaveTo(() => startCheckout())} className="text-[13px]">
          Start subscription
        </Button>
      ) : null}
    </div>
  );
}
