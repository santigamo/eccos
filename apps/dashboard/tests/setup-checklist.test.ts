import { describe, expect, test } from "bun:test";
import {
  setupComplete,
  setupDone,
  setupSteps,
} from "../src/lib/setup-checklist";
import type { DashboardState } from "../src/server/gateway";

/**
 * The first-run checklist's derivation (`src/lib/setup-checklist.ts`).
 *
 * Pure, and tested here rather than through the sidebar block that renders it:
 * that block is built out of router `Link`s and needs a RouterProvider this
 * suite does not have. What matters is not the markup anyway — it is that every
 * row is a FACT about the account, read fresh on each load, so a step cannot
 * stay ticked after the thing it describes is undone.
 */

function accountReady(wabaCount: number): DashboardState {
  return {
    stage: "account-ready",
    resources: {
      account: { accountId: "account-a", name: "A", createdAt: 1 },
      keys: [],
      wabas: Array.from({ length: wabaCount }, (_, i) => ({
        accountId: "account-a",
        wabaId: `waba-${i}`,
        callbackUrl: null,
        createdAt: 1,
        provisionedAt: null,
        status: "pending" as const,
        provisioningError: null,
        phones: [],
        coexistence: {
          onboardingType: "standard" as const,
          verifiedOnboardingType: null,
          status: "not_applicable" as const,
          deadlineAt: null,
          contactsStartedAt: null,
          contactsRequestId: null,
          historyStartedAt: null,
          historyRequestId: null,
          error: null,
        },
      })),
      phones: [],
    },
  };
}

function ready(inbound: number): DashboardState {
  return {
    stage: "ready",
    status: { counts: { inbound, outbound: {}, deliveries: {} } },
    scope: {},
  } as unknown as DashboardState;
}

function stateOf(state: DashboardState, hasTarget: boolean): Record<string, string> {
  return Object.fromEntries(setupSteps(state, hasTarget).map((step) => [step.id, step.state]));
}

describe("setupSteps", () => {
  test("four steps, each pointing at the page that produces its fact", () => {
    // No step-only routes and no wizard: attaching a number is a recurring
    // operation, so every row is a link into the console an operator already
    // has (routes/numbers.tsx, bead eccos-up9).
    expect(setupSteps(ready(1), true).map((step) => [step.id, step.href])).toEqual([
      ["workspace", "/onboarding"],
      ["number", "/numbers"],
      ["target", "/webhooks"],
      // INBOUND, and deliberately not a test send: a fresh WABA has no approved
      // template for minutes to days, so a send would gate first run on Meta's
      // review queue. Receiving a message needs nothing but the number, and it
      // exercises the forwarding target above it too.
      ["message", "/inbound"],
    ]);
  });

  test("a session with no workspace has done nothing yet", () => {
    expect(stateOf({ stage: "no-organization" }, false)).toEqual({
      workspace: "todo",
      number: "todo",
      target: "todo",
      message: "todo",
    });
  });

  test("an account with no WABA has only the workspace", () => {
    expect(stateOf(accountReady(0), false)).toEqual({
      workspace: "done",
      number: "todo",
      target: "todo",
      message: "todo",
    });
  });

  test("a WABA still waiting on its phone number reads as in progress", () => {
    // The one state that is neither. Calling it "to do" would tell an operator
    // to redo work Meta is already holding.
    expect(stateOf(accountReady(1), false).number).toBe("in-progress");
    expect(setupDone(setupSteps(accountReady(1), false))).toBe(1);
  });

  test("the forwarding target is read from the server, not from a stored tick", () => {
    // Same account, two answers — which is the whole point of deriving it:
    // an operator who removes their target loses the tick again.
    expect(stateOf(ready(0), true).target).toBe("done");
    expect(stateOf(ready(0), false).target).toBe("todo");
  });

  test("the last step needs a received message, not just a live number", () => {
    expect(stateOf(ready(0), true).message).toBe("todo");
    expect(stateOf(ready(3), true).message).toBe("done");
  });

  test("all four facts complete the checklist, which then has nothing to say", () => {
    const steps = setupSteps(ready(1), true);
    expect(setupDone(steps)).toBe(4);
    expect(setupComplete(steps)).toBe(true);
    // And an unfinished one never claims to be complete, so the block cannot
    // disappear while a step is outstanding.
    expect(setupComplete(setupSteps(ready(1), false))).toBe(false);
  });
});
