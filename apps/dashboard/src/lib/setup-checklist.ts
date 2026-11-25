import type { DashboardState } from "../server/gateway";

/**
 * The sidebar setup companion's reading of the account: the funnel stages
 * Eccos can observe today, each derived from server state on every load.
 *
 * Nothing is stored. An operator who removes their forwarding target and
 * revokes their last key loses that tick again, so the companion describes the
 * account rather than its history. The only thing a viewer may persist is the
 * decision to stop looking at it (see `nav-setup.tsx`).
 *
 * Every row links to the real page that produces its fact, except a DONE step
 * whose action is not repeatable: linking a done workspace to /onboarding
 * would hand the operator a duplicate-maker (docs/console-gaps-2026-09.md §2).
 * That exception is `href: null`.
 *
 * Type-only import, like `scope-requirements.ts`, so the derivation stays
 * exercisable under plain `bun test`.
 */

export type SetupStepId = "workspace" | "number" | "setup" | "message";

/**
 * `in-progress` exists for one real state: a WABA that is connected and still
 * waiting on Meta for its phone number. Calling that "to do" would tell an
 * operator to redo work Meta is already holding.
 */
export type SetupStepState = "done" | "in-progress" | "todo";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  /** The real page for this step; `null` when done and not repeatable. */
  href: string | null;
  state: SetupStepState;
}

/**
 * The billing and activation states the companion shows (`companionBilling`).
 * Absent means there is nothing to say, and the companion falls back to the
 * setup facts alone.
 * - `activated`: the first message went through and the 72h window runs; `left` in ms.
 * - `paused`: the window closed without a subscription.
 * - `paid`: an active subscription; the companion has nothing left to say.
 */
export type CompanionBilling =
  | { stage: "activated"; left: number }
  | { stage: "paused" }
  | { stage: "paid" };

/**
 * The kinds a human produces: a customer writing in (`reply` for text,
 * `message` for any other type) and the business writing from the WhatsApp
 * Business app under coexistence (`echo` / `message_echo`).
 */
export function humanMessageCount(byType: Record<string, number>): number {
  return (byType.reply ?? 0) + (byType.message ?? 0) + (byType.echo ?? 0) + (byType.message_echo ?? 0);
}

function resourcesOf(state: DashboardState) {
  return state.stage === "account-ready" ? state.resources : state.stage === "ready" ? state.scope.resources : undefined;
}

/**
 * The account's billing stage, from the gateway's status and funnel clock. A
 * paying status is `paid`; `setup` only says something once it activated and
 * its 72h run. Billing off (`open`) and a legacy account have nothing to say.
 */
export function companionBilling(state: DashboardState, now: number): CompanionBilling | undefined {
  const account = resourcesOf(state)?.account;
  if (!account) return undefined;
  const status = account.billingStatus;
  if (status === "active" || status === "past_due" || status === "cancelled") return { stage: "paid" };
  if (status === "paused") return { stage: "paused" };
  const funnel = account.funnel;
  if (status !== "setup" || !funnel?.activatedAt || funnel.pausesAt === null) return undefined;
  return { stage: "activated", left: Math.max(0, funnel.pausesAt - now) };
}

export function setupSteps(state: DashboardState, hasForwardingTarget: boolean): SetupStep[] {
  const resources = resourcesOf(state);
  const hasLiveKey = resources?.keys.some((key) => key.revokedAt === null) ?? false;
  // Activation proves a way out already works: path A replies from the inbox and needs neither.
  const activated = Boolean(resources?.account?.funnel?.activatedAt);
  // Counted by kind: `counts.inbound` includes the `delivered` receipt for the
  // operator's own test send, which is not anyone writing in.
  const byType = state.stage === "ready" ? state.status.counts.inboundByType ?? {} : {};
  return [
    {
      id: "workspace",
      label: "Workspace",
      // A todo workspace exists only for no-organization sessions, where the
      // root loader forces every route to /onboarding anyway.
      href: state.stage === "no-organization" ? "/onboarding" : null,
      state: state.stage === "no-organization" ? "todo" : "done",
    },
    {
      id: "number",
      label: "Number",
      href: "/numbers",
      state: state.stage === "ready" ? "done" : (resources?.wabas.length ?? 0) > 0 ? "in-progress" : "todo",
    },
    {
      // Either way out of Eccos counts: a forwarding target for a tool, an API
      // key for software that sends, or an activation from the inbox.
      id: "setup",
      label: "Webhook or API key",
      href: "/setup",
      state: hasForwardingTarget || hasLiveKey || activated ? "done" : "todo",
    },
    {
      // An incoming message, not a test send: a fresh WABA has no approved
      // template for minutes to days, so a send would gate first run on
      // Meta's review queue.
      id: "message",
      label: "First message",
      href: "/events",
      state: humanMessageCount(byType) > 0 ? "done" : "todo",
    },
  ];
}

/** How many steps are facts. `in-progress` does not count: it is not done yet. */
export function setupDone(steps: SetupStep[]): number {
  return steps.filter((step) => step.state === "done").length;
}

/** The step the operator is on: the first one that is not done. */
export function currentStep(steps: SetupStep[]): SetupStep | undefined {
  return steps.find((step) => step.state !== "done");
}

/**
 * Whether the companion shows. A paid workspace never needs it. Activated and
 * paused still have something to say (the countdown, the pause), so they keep
 * it up once billing feeds them. Without billing, it hides once every
 * observable step is done.
 */
export function companionVisible(steps: SetupStep[], billing?: CompanionBilling): boolean {
  if (billing) return billing.stage !== "paid";
  return currentStep(steps) !== undefined;
}
