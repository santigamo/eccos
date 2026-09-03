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
import type { NavItem } from "../src/components/blocks/app-shell-7/components/data";

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

/** The sidebar is grouped (`NavGroup[]`); what these tests care about is the
 * flat set of destinations it offers. */
const NAV_ITEMS: NavItem[] = NAV_MAIN.flatMap((group) => group.items);

describe("SCOPE_REQUIREMENTS", () => {
  test("says exactly which level each route needs", () => {
    // Spelled out rather than derived: changing what a route needs before a
    // number exists is a product decision, and it should have to be made here.
    expect(SCOPE_REQUIREMENTS).toEqual({
      "/numbers": "none",
      // `"none"`, and UNLISTED (see the nav test below): the pasted-token page
      // is how Meta's Cloud API test number gets attached, and an account with
      // no number is exactly who needs it (eccos-up9). Gating it on a WABA
      // would lock the one form that creates one.
      "/numbers/attach-token": "none",
      "/workspaces/new": "none",
      // WABA-level, like /templates: the forwarding target is what an operator
      // prepares BEFORE any traffic, so it must be reachable on a WABA that is
      // still waiting for its phone number.
      "/webhooks": "waba",
      "/templates": "waba",
      // Still `"none"` — but on the Workspace panel's merits now, not the token
      // panel's: the account id is an account-level fact and does not wait on a
      // number. The token panel left for /numbers/attach-token.
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
    // ZERO WABAs keeps the waba-level pages locked, and correctly: a forwarding
    // target has no home and there is no WABA whose templates to list.
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
    expect(requirementSatisfied("/webhooks", limbo)).toBe(true);
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
    // Nothing to forward to yet, and nothing to configure: /webhooks is a
    // WABA-level page and stays locked with zero WABAs.
    expect(requirementSatisfied("/webhooks", empty)).toBe(false);
    // The OTHER way out, and it has to stay reachable: its token panel attaches
    // the Cloud API test number, which by definition is needed by an account
    // that has none.
    expect(requirementSatisfied("/numbers/attach-token", empty)).toBe(true);
    // Settings carries only the Workspace panel now, and an account id exists
    // before any number does.
    expect(requirementSatisfied("/settings", empty)).toBe(true);
  });
});

describe("nav and the root redirect agree", () => {
  test("every nav item's requirement is the map's requirement for its href", () => {
    // THE ANTI-DRIFT ASSERTION. This test fails if the sidebar and the root
    // redirect ever disagree about which pages exist before a number — the
    // failure mode being an item that looks live and bounces on click, or one
    // that is greyed out on a page the operator can actually reach.
    for (const item of NAV_ITEMS) {
      const expected = requirementFor(item.href);
      const actual = item.requires ?? "none";
      expect(actual, item.href).toBe(expected);
    }
  });

  test("every nav href is named in the map, so no item rides the default", () => {
    for (const item of NAV_ITEMS) {
      expect(Object.hasOwn(SCOPE_REQUIREMENTS, item.href), item.href).toBe(true);
    }
  });

  test("the map may name routes the nav does not — /numbers/attach-token is one", () => {
    // THE ASYMMETRY IS DELIBERATE, and this test exists so nobody "repairs" it.
    // The pasted-token page must be REACHABLE (hence the map entry: without it
    // the root loader would bounce a bookmarked visit to /numbers) and must NOT
    // be ADVERTISED (hence its absence from the sidebar): it can only ever work
    // for a token issued by this deployment's own Meta app, so every customer
    // who found it would meet a form that can only refuse them. Decided
    // 2026-09-03; see routes/numbers_.attach-token.tsx for the alternatives
    // that were rejected. The drift check above therefore reads nav → map, and
    // never map → nav.
    expect(SCOPE_REQUIREMENTS["/numbers/attach-token"]).toBe("none");
    expect(NAV_ITEMS.some((item) => item.href === "/numbers/attach-token")).toBe(false);
    // And nothing else in the interface points at it either — the sentence on
    // /numbers that used to send operators to Settings was removed, not
    // repointed (routes/numbers.tsx).
  });
});

describe("the sidebar's groups", () => {
  test("three named groups over a lead row, and no collapsibles", () => {
    // Nine items do not need collapsing; what the grouping buys is that the
    // `requires` levels cluster, so a fresh account dims the whole LOGS group
    // as "later" rather than three unrelated grey rows.
    expect(NAV_MAIN.map((group) => group.label)).toEqual([
      null,
      "Setup",
      "Logs",
      "Workspace",
    ]);
    expect(NAV_MAIN.map((group) => group.items.map((item) => item.href))).toEqual([
      ["/"],
      ["/numbers", "/webhooks", "/templates"],
      ["/deliveries", "/inbound", "/outbound"],
      ["/settings"],
    ]);
  });

  test("every item is named once, so nothing is listed twice", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
