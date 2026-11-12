import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Shown while the workspace may not add numbers. Messaging is never affected. */
export function SubscriptionNotice() {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-l-warning px-3 py-2">
      <p className="m-0 max-w-prose text-sm text-pretty text-foreground">
        Adding a number needs an active subscription. Messaging on the numbers already connected keeps working.
      </p>
      <a href="/settings" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
        Open billing
      </a>
    </div>
  );
}
