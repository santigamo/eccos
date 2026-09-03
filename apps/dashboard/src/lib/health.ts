import type { GatewayStatus, Health } from "../server/gateway";

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
 * when an operator sees a banner it always means something). */
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
    rail: "border-l-[#f0a020]",
  },
  unhealthy: {
    detail: "The gateway is experiencing an outage.",
    rail: "border-l-[#e03131]",
  },
};

/**
 * ── THE HELD READING ────────────────────────────────────────────────────────
 * `degraded` means "reduced capacity" only when there is somewhere to send.
 * With no forwarding target configured, `alarm()` HOLDS the drain
 * (`apps/gateway/src/gateway.ts`) and the pending rows pile up until an
 * operator names a receiver — which `healthFromCounts` reads as `degraded` past
 * ten rows. Nothing is degraded there: nothing has been attempted, nothing has
 * failed, and the gateway is doing exactly what it was told to. Saying "reduced
 * capacity" sends an operator hunting for a fault that does not exist, and
 * hides the one action that clears the state.
 *
 * `hasForwardingTarget` is already on the root loader (the sidebar checklist
 * reads it), so telling the two cases apart costs no extra read.
 *
 * Only when held rows are the ONLY reason for `degraded`. A gateway that also
 * has failed outbound sends is degraded for a second, unrelated reason, and one
 * sentence naming only the queue would hide it — so that case keeps the generic
 * line and the facts strip's red `failed` count carries the other half.
 */
export function healthReading(status: GatewayStatus, hasForwardingTarget: boolean): HealthReading {
  const label = HEALTH_LABEL[status.health];
  const held = status.counts.deliveries.pending ?? 0;
  const outboundFailed = status.counts.outbound.failed ?? 0;
  if (status.health === "degraded" && !hasForwardingTarget && held > 0 && outboundFailed === 0) {
    return {
      label,
      banner: {
        detail: `${held} ${held === 1 ? "event is" : "events are"} waiting for a forwarding target. Nothing has been attempted and nothing has failed — they go out as soon as you name a receiver.`,
        rail: "border-l-[#f0a020]",
        action: { to: "/webhooks", label: "Set a forwarding target" },
      },
    };
  }
  return { label, banner: GENERIC_BANNER[status.health] };
}
