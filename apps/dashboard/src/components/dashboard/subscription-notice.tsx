import { startCheckout } from "../../server/gateway";
import { closedNotice } from "../../billing/notice";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BillingError, useBillingRedirect } from "./billing-redirect";

/** `startCheckout` opens the portal while a subscription still exists, so the button says which. */
function billingActionLabel(subscribed: boolean): string {
  return subscribed ? "Manage billing" : "Start subscription";
}

/**
 * The warning a closed workspace reads beside the connect fork. With billing on
 * it offers the way out; the gateway refuses a new number either way with
 * `subscription_required`.
 */
export function SubscriptionNotice({
  billing,
  subscribed = false,
  numbers,
  reconnect,
  className,
}: {
  billing: boolean;
  subscribed?: boolean;
  /** Billable numbers the workspace has now: what a checkout would charge for. */
  numbers: number;
  /** The workspace owns a WABA, so the fork can still re-register what it has. */
  reconnect: boolean;
  className?: string;
}) {
  const { busy, error, leaveTo } = useBillingRedirect();
  return (
    <div className={cn("mb-4 border-l-2 border-l-warning px-3 py-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 max-w-prose text-sm text-pretty text-foreground">
          {closedNotice(billing, numbers)}
          {reconnect
            ? ` ${billing ? "Without one, " : ""}Meta's flow ends with the new number left out. Numbers already connected keep working and can be reconnected.`
            : null}
        </p>
        {billing ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void leaveTo(() => startCheckout())}>
            {billingActionLabel(subscribed)}
          </Button>
        ) : null}
      </div>
      <BillingError error={error} />
    </div>
  );
}

/**
 * First run on a closed workspace with billing on: there is nothing to
 * reconnect, so this stands where the connect fork would, before Meta's window.
 */
export function SubscriptionGate({ subscribed = false }: { subscribed?: boolean }) {
  const { busy, error, leaveTo } = useBillingRedirect();
  return (
    <Frame variant="default" spacing="lg" className="max-w-3xl">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Subscription
          </FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            {closedNotice(true, 0)} Messages are never billed. Once it is active, come back here to connect your number.
          </FrameDescription>
        </FrameHeader>
        <div className="pt-5">
          <Button type="button" disabled={busy} onClick={() => void leaveTo(() => startCheckout())}>
            {billingActionLabel(subscribed)}
          </Button>
        </div>
        <BillingError error={error} />
      </FramePanel>
    </Frame>
  );
}
