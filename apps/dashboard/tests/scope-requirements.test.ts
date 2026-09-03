import { describe, expect, test } from "bun:test";
import {
  SCOPE_REQUIREMENTS,
  hasNumberScope,
  hasWabaScope,
  requirementFor,
  requirementSatisfied,
} from "../src/lib/scope-requirements";
import type { DashboardState } from "../src/server/gateway";
import { NAV_MAIN } from "../src/components/blocks/app-shell-7/components/data";

/**
 * Which pages exist before a number does (`src/lib/scope-requirements.ts`).
 *
 * Two consumers read this map — the sidebar's lock and the root loader's
 * bounce — and they used to be two separate hand-maintained rules. The tests
 * below pin the map itself and then assert the two agree.
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

const READY = { stage: "ready" } as unknown as DashboardState;

describe("SCOPE_REQUIREMENTS", () => {
  test("says exactly which level each route needs", () => {
    // Spelled out rather than derived: changing what a route needs before a
    // number exists is a product decision, and it should have to be made here.
    expect(SCOPE_REQUIREMENTS).toEqual({
      "/numbers": "none",
      "/workspaces/new": "none",
      "/templates": "waba",
      // `"none"`, not `"waba"`: Settings carries the pasted-token panel, which
      // is how Meta's Cloud API test number gets attached — and an account with
      // no number is exactly who needs it (eccos-up9). Gating the page on a
      // WABA locked the one form that creates one.
      "/settings": "none",
      "/": "number",
      "/deliveries": "number",
      "/inbound": "number",
      "/outbound": "number",
    });
  });

  test("an unlisted route defaults to needing a number", () => {
    // Preserves the old bounce for anything not named (e.g. /invitations): the
    // safe direction is towards /numbers, not towards a page that will throw.
    expect(requirementFor("/invitations")).toBe("number");
    expect(requirementFor("/some/future/page")).toBe("number");
  });
});

describe("scope predicates", () => {
  test("hasWabaScope needs a WABA to exist, not an active one", () => {
    expect(hasWabaScope(READY)).toBe(true);
    expect(hasWabaScope(accountReady(1))).toBe(true);
    // ZERO WABAs keeps the waba-level pages locked, and correctly: subscriber
    // config has no home and there is no WABA whose templates to list.
    expect(hasWabaScope(accountReady(0))).toBe(false);
    expect(hasWabaScope({ stage: "no-organization" })).toBe(false);
  });

  test("hasNumberScope stays strict: only a ready stage has a data plane", () => {
    expect(hasNumberScope(READY)).toBe(true);
    expect(hasNumberScope(accountReady(1))).toBe(false);
  });

  test("the awaiting-a-phone account reaches templates and settings, not the logs", () => {
    const limbo = accountReady(1);
    expect(requirementSatisfied("/numbers", limbo)).toBe(true);
    expect(requirementSatisfied("/templates", limbo)).toBe(true);
    expect(requirementSatisfied("/settings", limbo)).toBe(true);
    expect(requirementSatisfied("/", limbo)).toBe(false);
    expect(requirementSatisfied("/deliveries", limbo)).toBe(false);
    expect(requirementSatisfied("/inbound", limbo)).toBe(false);
    expect(requirementSatisfied("/outbound", limbo)).toBe(false);
  });

  test("an account with no WABA at all only reaches the ways out", () => {
    const empty = accountReady(0);
    expect(requirementSatisfied("/numbers", empty)).toBe(true);
    expect(requirementSatisfied("/workspaces/new", empty)).toBe(true);
    expect(requirementSatisfied("/templates", empty)).toBe(false);
    // Settings is the SECOND way out, and has to stay reachable: its token
    // panel attaches the Cloud API test number, which by definition is needed
    // by an account that has no number. The page's WABA-level sections degrade
    // to a note in this state rather than failing (routes/settings.tsx).
    expect(requirementSatisfied("/settings", empty)).toBe(true);
  });
});

describe("nav and the root redirect agree", () => {
  test("every nav item's requirement is the map's requirement for its href", () => {
    // THE ANTI-DRIFT ASSERTION. This test fails if the sidebar and the root
    // redirect ever disagree about which pages exist before a number — the
    // failure mode being an item that looks live and bounces on click, or one
    // that is greyed out on a page the operator can actually reach.
    for (const item of NAV_MAIN) {
      const expected = requirementFor(item.href);
      const actual = item.requires ?? "none";
      expect(actual, item.href).toBe(expected);
    }
  });

  test("every nav href is named in the map, so no item rides the default", () => {
    for (const item of NAV_MAIN) {
      expect(Object.hasOwn(SCOPE_REQUIREMENTS, item.href), item.href).toBe(true);
    }
  });
});
