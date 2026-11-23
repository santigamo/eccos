import type { GatewayStatus, Health } from "../server/gateway";
import { heldSentence, targetMissing } from "./forwarding";

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

/** One line of the banner. A healthy gateway raises none: the tag beside the
 * heading already says it (data rule 1 — when an operator sees a banner it
 * always means something). Held events are the one line it can still raise. */
export interface HealthBanner {
  detail: string;
  /**
   * Left rail of the banner. The semantic colour lives on the rail — a
   * neutral hairline there reads as decoration and says nothing.
   */
  rail: string;
  /** The page that resolves the state, when one exists. A real route, never a
   * step inside a flow — the console has no wizard (`lib/setup-checklist.ts`). */
  action?: { to: string; label: string; search?: Record<string, string> };
}

export interface HealthReading {
  label: string;
  /** One line per fact, each with its own action. Empty while there is nothing to say. */
  banners: HealthBanner[];
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
 * Three facts can stand at once, and each keeps its own line and its own door:
 * forwards that failed every retry, sends Meta refused, and events held for a
 * target nobody has set. Folding two into one sentence hides one of the doors.
 *
 * ── THE HELD LINE ───────────────────────────────────────────────────────────
 * With no forwarding target, `alarm()` HOLDS the drain
 * (`apps/gateway/src/gateway.ts`) and each pending row waits until the content
 * window deletes it. That is a deadline only the operator can act on, so the
 * line shows at any count and under any health word. Only on a CONFIRMED
 * missing target (`targetMissing`): a failed read says nothing.
 *
 * With none of the three, the health word's generic sentence stands.
 */
export function healthReading(
  status: GatewayStatus,
  hasForwardingTarget: boolean | null,
  retentionDays?: number | null,
): HealthReading {
  const banners: HealthBanner[] = [];
  const failed = status.counts.deliveries.failed ?? 0;
  if (failed > 0) {
    banners.push({
      detail: `${failed} forwarded ${failed === 1 ? "batch" : "batches"} failed after every retry. Check your server, then retry ${failed === 1 ? "it" : "them"} from the forwarding queue.`,
      rail: "border-l-destructive",
      action: { to: "/deliveries", label: "Open the forwarding queue" },
    });
  }
  const unsent = status.counts.outbound.failed ?? 0;
  if (unsent > 0) {
    banners.push({
      detail: `${unsent} ${unsent === 1 ? "message" : "messages"} failed to send.`,
      rail: "border-l-warning",
      action: { to: "/messages", label: "Open the failed messages", search: { status: "failed" } },
    });
  }
  const held = status.counts.deliveries.pending ?? 0;
  if (targetMissing(hasForwardingTarget) && held > 0) {
    banners.push({
      detail: heldSentence(held, retentionDays),
      rail: "border-l-warning",
      action: { to: "/webhooks", label: "Set a forwarding target" },
    });
  }
  const generic = GENERIC_BANNER[status.health];
  return { label: HEALTH_LABEL[status.health], banners: banners.length > 0 || !generic ? banners : [generic] };
}
