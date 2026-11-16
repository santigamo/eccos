import type { GatewayStatus, Health } from "../server/gateway";
import { heldSentence } from "./forwarding";

/**
 * What the Status page SAYS about the gateway's health.
 *
 * Pure, and split out of `routes/index.tsx` for the same reason
 * `lib/forwarding.ts` is split out of `routes/webhooks.tsx`: the sentence a
 * page shows an operator is a rule, not decoration, and this one has a branch
 * that is easy to get quietly wrong — so it is asserted without a DOM (the
 * banner's action renders a router `Link`, which needs a RouterProvider).
 *
 * Type-only import from `server/gateway`, like `lib/setup-checklist.ts`, so the
 * derivation stays exercisable under plain `bun test`.
 */

/** The banner a state raises. `null` means the state speaks for itself: healthy
 * needs no sentence, the tag beside the heading already says it (data rule 1 —
 * when an operator sees a banner it always means something). Held events are
 * the one banner a healthy gateway raises. */
export interface HealthBanner {
  detail: string;
  /**
   * Left rail of the banner. The semantic colour lives on the rail — a
   * neutral hairline there reads as decoration and says nothing.
   */
  rail: string;
  /** The page that resolves the state, when one exists. A real route, never a
   * step inside a flow — the console has no wizard (`lib/setup-checklist.ts`). */
  action?: { to: string; label: string };
}

export interface HealthReading {
  label: string;
  banner: HealthBanner | null;
}

const HEALTH_LABEL: Record<Health, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  unhealthy: "Unhealthy",
};

/** What each health word says when nothing more specific is known. */
const GENERIC_BANNER: Record<Health, HealthBanner | null> = {
  healthy: null,
  degraded: {
    detail: "The gateway is running with reduced capacity.",
    rail: "border-l-warning",
  },
  unhealthy: {
    detail: "Forwarding to your server is failing.",
    rail: "border-l-destructive",
  },
};

/**
 * ── THE HELD READING ────────────────────────────────────────────────────────
 * With no forwarding target, `alarm()` HOLDS the drain
 * (`apps/gateway/src/gateway.ts`) and each pending row waits until the content
 * window deletes it. That is a deadline only the operator can act on, so it
 * raises the banner at any count, whatever the health word. The gateway only
 * reads `degraded` past ten held rows, so waiting for that hid the first nine.
 *
 * Only on a CONFIRMED missing target: `null` is a read that failed, and saying
 * "waiting for a forwarding target" to an account that has one is worse than
 * saying nothing.
 *
 * Failed forwards are a real fault and come first. Failed outbound sends are a
 * second, unrelated fact, so the held sentence names them too.
 */
export function healthReading(
  status: GatewayStatus,
  hasForwardingTarget: boolean | null,
  retentionDays?: number | null,
): HealthReading {
  const label = HEALTH_LABEL[status.health];
  // `unhealthy` means only this: forwarded batches that failed every attempt.
  const failed = status.counts.deliveries.failed ?? 0;
  if (status.health === "unhealthy" && failed > 0) {
    return {
      label,
      banner: {
        detail: `${failed} forwarded ${failed === 1 ? "batch" : "batches"} failed after every retry. Check your server, then retry ${failed === 1 ? "it" : "them"} from the forwarding queue.`,
        rail: "border-l-destructive",
        action: { to: "/deliveries", label: "Open the forwarding queue" },
      },
    };
  }
  const held = status.counts.deliveries.pending ?? 0;
  if (hasForwardingTarget === false && held > 0) {
    const unsent = status.counts.outbound.failed ?? 0;
    const also = unsent > 0 ? ` ${unsent} ${unsent === 1 ? "message" : "messages"} also failed to send.` : "";
    return {
      label,
      banner: {
        detail: `${heldSentence(held, retentionDays)}${also}`,
        rail: "border-l-warning",
        action: { to: "/webhooks", label: "Set a forwarding target" },
      },
    };
  }
  return { label, banner: GENERIC_BANNER[status.health] };
}
