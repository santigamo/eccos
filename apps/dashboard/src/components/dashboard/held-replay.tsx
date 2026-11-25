import { useState } from "react";
import { isRedirect } from "@tanstack/react-router";
import { RotateCcwIcon } from "lucide-react";
import type { HeldEvents } from "@eccos/gateway-contract";
import { Button } from "@/components/ui/button";
import { replayHeldEvents } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { BillingError } from "./billing-redirect";

export const LATE_REPLY_WARNING = "If your tool answers customers on its own, they may get late replies.";

/**
 * After payment: the events stored while the workspace was paused wait for the
 * customer's decision. Never sent automatically, so nothing goes out until the
 * button is pressed; an owner or admin presses it.
 */
export function HeldReplay({
  held,
  canReplay,
  onReplayed,
}: {
  held: HeldEvents;
  canReplay: boolean;
  onReplayed?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = held.events;

  async function replay() {
    setBusy(true);
    setError(null);
    try {
      const res = await replayHeldEvents();
      if (!res.ok) setError(failureCopy(res).detail);
      else if (!res.data.ok) setError("The workspace is still paused, so nothing was sent.");
      else await onReplayed?.();
    } catch (thrown) {
      if (isRedirect(thrown)) throw thrown;
      setError("The replay did not go through. Try again.");
    }
    setBusy(false);
  }

  return (
    <section className="mb-6 flex max-w-3xl flex-col gap-2 border-b border-border pb-6">
      <h2 className="m-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">While you were paused</h2>
      <p className="m-0 text-sm font-medium text-foreground">
        {n} {n === 1 ? "event is" : "events are"} stored and your tool has not seen them
      </p>
      <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">{LATE_REPLY_WARNING}</p>
      {canReplay ? (
        <div className="pt-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void replay()}>
            <RotateCcwIcon aria-hidden="true" />
            Replay {n} stored {n === 1 ? "event" : "events"}
          </Button>
        </div>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">Ask an owner or admin of this workspace to replay them.</p>
      )}
      <BillingError error={error} />
    </section>
  );
}
