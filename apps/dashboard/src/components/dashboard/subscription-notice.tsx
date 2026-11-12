import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A warning, never a gate: connecting stays available so a number already here
 * can be reconnected. The gateway refuses a new one with `subscription_required`.
 * Without billing on this console there is no subscription to point at.
 */
export function SubscriptionNotice({ billing }: { billing: boolean }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-l-warning px-3 py-2">
      <p className="m-0 max-w-prose text-sm text-pretty text-foreground">
        {billing
          ? "Adding a new number needs an active subscription."
          : "This workspace cannot add new numbers."}{" "}
        Numbers already connected keep working and can be reconnected.
      </p>
      {billing ? (
        <a href="/settings" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          Open billing
        </a>
      ) : null}
    </div>
  );
}
