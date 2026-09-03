import type { DashboardState } from "../server/gateway";

/**
 * First-run progress, as four FACTS about the account — never as stored state.
 *
 * ── WHY THIS IS NOT A WIZARD ────────────────────────────────────────────────
 * `routes/numbers.tsx` and bead eccos-up9 both record the standing decision
 * against one: attaching a number is a recurring operation, so a wizard would
 * exist for the first number and be in the way of every one after it. What a
 * new operator actually lacks is not a guided path — every step already has a
 * page — but the KNOWLEDGE THAT THE STEPS EXIST. So this is a reading of the
 * pages that already exist, rendered beside them, and every row is a link to
 * the real page rather than a step inside a flow.
 *
 * ── WHY NOTHING IS STORED ───────────────────────────────────────────────────
 * Each step is derived from server state on every load. Stored progress goes
 * wrong in exactly the way that matters here: an operator who removes their
 * forwarding target would keep a ticked box, and the checklist would be
 * describing history instead of the account. The only thing a viewer may
 * persist is the decision to stop looking at it (see `nav-setup.tsx`).
 *
 * Type-only import, like `scope-requirements.ts`, so the derivation stays
 * exercisable under plain `bun test`.
 */

export type SetupStepId = "workspace" | "number" | "target" | "message";

/**
 * `in-progress` exists for one real state and only one: a WABA that is
 * connected and still waiting on Meta for its phone number. Calling that
 * "to do" would tell an operator to redo work Meta is already holding.
 */
export type SetupStepState = "done" | "in-progress" | "todo";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  /** The real page for this step. There is no step-only route. */
  href: string;
  state: SetupStepState;
}

export function setupSteps(state: DashboardState, hasForwardingTarget: boolean): SetupStep[] {
  const wabas = state.stage === "account-ready" ? state.resources.wabas : [];
  const inbound = state.stage === "ready" ? state.status.counts.inbound : 0;
  return [
    {
      id: "workspace",
      label: "Workspace",
      href: "/onboarding",
      // Reaching any of this at all means the session resolved a membership,
      // so the row is done the moment the checklist can be seen. It is listed
      // anyway: a checklist that starts at step two hides that step one
      // happened, and an operator counting rows should count what they did.
      state: state.stage === "no-organization" ? "todo" : "done",
    },
    {
      id: "number",
      label: "Number",
      href: "/numbers",
      state:
        state.stage === "ready" ? "done" : wabas.length > 0 ? "in-progress" : "todo",
    },
    {
      id: "target",
      label: "Forwarding target",
      href: "/webhooks",
      state: hasForwardingTarget ? "done" : "todo",
    },
    {
      id: "message",
      label: "First message",
      href: "/inbound",
      // INBOUND, deliberately, and not a test send. A fresh WABA has no
      // approved template for minutes to days and the console has no free-text
      // send, so making the last step a send would gate first run on Meta's
      // review queue. "Message the number from your phone and watch it land"
      // needs nothing but the number, and it exercises the whole pipe —
      // including the forwarding target above it.
      state: inbound > 0 ? "done" : "todo",
    },
  ];
}

/** How many steps are facts. `in-progress` does not count: it is not done yet. */
export function setupDone(steps: SetupStep[]): number {
  return steps.filter((step) => step.state === "done").length;
}

/** Nothing left to say. The block hides itself here rather than parking a
 * permanent 4/4 in the sidebar of an account that finished setting up. */
export function setupComplete(steps: SetupStep[]): boolean {
  return setupDone(steps) === steps.length;
}
