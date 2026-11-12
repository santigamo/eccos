import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A warning, never a gate: connecting stays available so a number already here
 * can be reconnected. The gateway refuses a new one with `subscription_required`.
 */
export function SubscriptionNotice() {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-l-warning px-3 py-2">
      <p className="m-0 max-w-prose text-sm text-pretty text-foreground">
        Adding a new number needs an active subscription. Numbers already connected keep working and can be
        reconnected.
      </p>
      <a href="/settings" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
        Open billing
      </a>
    </div>
  );
}
