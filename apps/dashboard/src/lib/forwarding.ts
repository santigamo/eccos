import type { LastForward, SubscriberConfig } from "@eccos/gateway-contract";

/**
 * How the Webhooks page reads the forwarding state. Pure, so the two rules that
 * are easy to get quietly wrong can be asserted without a DOM.
 */

/** The header tag. A FACT about configuration, never a switch — Eccos has no
 * pause semantics, so there is nothing here to toggle. */
export function forwardingTag(config: SubscriberConfig): "forwarding" | "no target" {
  return config.url === null ? "no target" : "forwarding";
}

export interface LastForwardReading {
  /** The delivery row's own status, as the log shows it. */
  status: string;
  /**
   * Which moment `at` is. THE RULE THIS MODULE EXISTS FOR: a row with
   * `finishedAt: null` has not finished — it is queued, held for want of a
   * target, or between retries — and its only timestamp is when the batch
   * ARRIVED. Reporting that as a completion turns "queued 15 days ago" into
   * "delivered 15 days ago", which is the confusion `finished_at` was added to
   * end. Never fall back from one to the other.
   */
  moment: "queued" | "finished";
  /** Epoch ms of whichever moment `moment` names. */
  at: number;
  /** Attempts spent. `0` on a row nothing has been tried against — which is
   * what a held row looks like, and it is not a failure. */
  attempts: number;
  /** Verbatim from `deliveries.last_error`; only ever set on a real attempt. */
  lastError: string | null;
}

export function readLastForward(last: LastForward | null): LastForwardReading | null {
  if (!last) return null;
  const finished = last.finishedAt !== null;
  return {
    status: last.status,
    moment: finished ? "finished" : "queued",
    at: finished ? (last.finishedAt as number) : last.createdAt,
    attempts: last.attempts,
    lastError: last.lastError,
  };
}
