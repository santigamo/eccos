import { describe, expect, test } from "bun:test";
import {
  companionBilling,
  companionVisible,
  currentStep,
  setupDone,
  setupSteps,
} from "../src/lib/setup-checklist";
import type { AccountKeyResource } from "@eccos/gateway-contract";
import type { DashboardState } from "../src/server/gateway";

/**
 * The setup companion's derivation (`src/lib/setup-checklist.ts`). Every row is
 * a FACT about the account, read fresh on each load, so a step cannot stay
 * ticked after the thing it describes is undone.
 */

const liveKey: AccountKeyResource = { keyId: "k1", label: null, createdAt: 1, revokedAt: null };
const revokedKey: AccountKeyResource = { ...liveKey, revokedAt: 2 };

function accountReady(wabaCount: number, keys: AccountKeyResource[] = []): DashboardState {
  return {
    stage: "account-ready",
    resources: {
      account: { accountId: "account-a", name: "A", createdAt: 1 },
      keys,
      wabas: Array.from({ length: wabaCount }, (_, i) => ({ wabaId: `waba-${i}` })),
      phones: [],
    },
  } as unknown as DashboardState;
}

/**
 * `replies` and not a flat inbound count: `counts.inbound` includes the
 * `delivered` receipts for the operator's OWN sends.
 */
function ready(replies: number, statuses = 0, keys: AccountKeyResource[] = []): DashboardState {
  return {
    stage: "ready",
    status: {
      counts: {
        inbound: replies + statuses,
        inboundByType: { reply: replies, delivered: statuses },
        outbound: {},
        deliveries: {},
      },
    },
    scope: { resources: { keys, wabas: [], phones: [] } },
  } as unknown as DashboardState;
}

function stateOf(state: DashboardState, hasTarget: boolean): Record<string, string> {
  return Object.fromEntries(setupSteps(state, hasTarget).map((step) => [step.id, step.state]));
}

describe("setupSteps", () => {
  test("path A: an activation from the inbox marks the webhook-or-key step done", () => {
    const activated = ready(1);
    (activated as { scope: { resources: Record<string, unknown> } }).scope.resources.account = { funnel: { activatedAt: 5 } };
    expect(stateOf(activated, false).setup).toBe("done");
    expect(stateOf(ready(1), false).setup).toBe("todo");
  });

  test("four steps, each pointing at the page that produces its fact", () => {
    expect(setupSteps(ready(1), true).map((step) => [step.id, step.label, step.href])).toEqual([
      // A done workspace is not repeatable: no href, or it would open the
      // page that creates ANOTHER workspace (docs/console-gaps-2026-09.md §2).
      ["workspace", "Workspace", null],
      ["number", "Number", "/numbers"],
      ["setup", "Webhook or API key", "/setup"],
      ["message", "First message", "/events"],
    ]);
  });

  test("a todo workspace (no-organization) links to /onboarding", () => {
    const row = setupSteps({ stage: "no-organization" }, false).find((s) => s.id === "workspace");
    expect(row?.href).toBe("/onboarding");
    expect(stateOf({ stage: "no-organization" }, false)).toEqual({
      workspace: "todo",
      number: "todo",
      setup: "todo",
      message: "todo",
    });
  });

  test("an account with no WABA has only the workspace", () => {
    expect(stateOf(accountReady(0), false)).toEqual({
      workspace: "done",
      number: "todo",
      setup: "todo",
      message: "todo",
    });
  });

  test("a WABA still waiting on its phone number reads as in progress", () => {
    expect(stateOf(accountReady(1), false).number).toBe("in-progress");
    expect(setupDone(setupSteps(accountReady(1), false))).toBe(1);
  });

  test("set up is a forwarding target or a live API key", () => {
    expect(stateOf(ready(0), true).setup).toBe("done");
    expect(stateOf(ready(0, 0, [liveKey]), false).setup).toBe("done");
    expect(stateOf(accountReady(0, [liveKey]), false).setup).toBe("done");
    // Removing the target or revoking the key undoes the tick.
    expect(stateOf(ready(0), false).setup).toBe("todo");
    expect(stateOf(ready(0, 0, [revokedKey]), false).setup).toBe("todo");
  });

  test("the last step needs a received message, not just a live number", () => {
    expect(stateOf(ready(0), true).message).toBe("todo");
    expect(stateOf(ready(3), true).message).toBe("done");
  });

  test("a delivery receipt for the operator's own send does not tick it", () => {
    expect(stateOf(ready(0, 5), true).message).toBe("todo");
  });

  test("echoes and non-text messages count, because a human wrote them", () => {
    for (const kind of ["echo", "message", "message_echo"]) {
      const state = {
        stage: "ready",
        status: { counts: { inbound: 1, inboundByType: { [kind]: 1 }, outbound: {}, deliveries: {} } },
        scope: { resources: { keys: [], wabas: [], phones: [] } },
      } as unknown as DashboardState;
      expect(stateOf(state, true).message).toBe("done");
    }
  });
});

describe("currentStep", () => {
  test("is the first step that is not done", () => {
    expect(currentStep(setupSteps(accountReady(0), false))?.id).toBe("number");
    expect(currentStep(setupSteps(accountReady(1), false))?.id).toBe("number");
    expect(currentStep(setupSteps(ready(0), false))?.id).toBe("setup");
    expect(currentStep(setupSteps(ready(0), true))?.id).toBe("message");
    expect(currentStep(setupSteps(ready(1), true))).toBeUndefined();
  });
});

describe("companionVisible", () => {
  test("without billing, it shows until every observable step is done", () => {
    expect(companionVisible(setupSteps(ready(1), false))).toBe(true);
    expect(companionVisible(setupSteps(ready(1), true))).toBe(false);
  });

  test("billing decides once it is fed: paid hides, activated and paused show", () => {
    const done = setupSteps(ready(1), true);
    expect(companionVisible(done, { stage: "paid" })).toBe(false);
    expect(companionVisible(done, { stage: "activated", left: 40 * 3_600_000 })).toBe(true);
    expect(companionVisible(done, { stage: "paused" })).toBe(true);
    expect(companionVisible(setupSteps(ready(0), false), { stage: "paid" })).toBe(false);
  });
});

describe("companionBilling", () => {
  const HOUR = 60 * 60 * 1000;
  function withAccount(account: Record<string, unknown>): DashboardState {
    return {
      stage: "account-ready",
      resources: { account: { accountId: "a", name: "A", createdAt: 1, canAddNumber: false, ...account }, keys: [], wabas: [], phones: [] },
    } as unknown as DashboardState;
  }
  const clock = (activatedAt: number | null, pausesAt: number | null) => ({
    connectedAt: 0,
    activatedAt,
    pausesAt,
    pauseReason: activatedAt ? "window_ended" : "never_activated",
    warningDueAt: null,
  });

  test("an activated setup account carries the time left, never below zero", () => {
    const state = withAccount({ billingStatus: "setup", funnel: clock(1, 1 + 72 * HOUR) });
    expect(companionBilling(state, 1)).toEqual({ stage: "activated", left: 72 * HOUR });
    expect(companionBilling(state, 1 + 71.5 * HOUR)).toEqual({ stage: "activated", left: 0.5 * HOUR });
    expect(companionBilling(state, 1 + 80 * HOUR)).toEqual({ stage: "activated", left: 0 });
  });

  test("paused and paying statuses say so; a setup account not yet activated says nothing", () => {
    expect(companionBilling(withAccount({ billingStatus: "paused" }), 0)).toEqual({ stage: "paused" });
    for (const billingStatus of ["active", "past_due", "cancelled"]) {
      expect(companionBilling(withAccount({ billingStatus }), 0)).toEqual({ stage: "paid" });
    }
    expect(companionBilling(withAccount({ billingStatus: "setup", funnel: clock(null, 14 * 24 * HOUR) }), 0)).toBeUndefined();
  });

  test("billing off, a legacy account and an older gateway say nothing", () => {
    expect(companionBilling(withAccount({ billingStatus: "open", funnel: clock(1, null) }), 0)).toBeUndefined();
    expect(companionBilling(withAccount({ billingStatus: "setup", funnel: clock(null, null) }), 0)).toBeUndefined();
    expect(companionBilling(withAccount({ billingStatus: "setup" }), 0)).toBeUndefined();
  });
});
