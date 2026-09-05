import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardState } from "../src/server/gateway";

/**
 * The sidebar checklist renderer (`nav-setup.tsx`) and its half of the §2
 * decision in docs/console-gaps-2026-09.md: a DONE step whose action is not
 * repeatable is rendered as plain text, never a link. The derivation half is
 * pinned in `tests/setup-checklist.test.ts` (the null-href contract); what is
 * pinned here is that the renderer honors it — a null-href row must come out as
 * text, so the live UI cannot keep a done row clickable.
 *
 * `NavSetup` reads the root loader and search params through TanStack Router
 * hooks, so both modules are stubbed with `mock.module` before the import (same
 * approach as `tests/gateway.test.ts`), and the checklist state is fed directly.
 * React's `renderToStaticMarkup` needs no DOM.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

let loaderData: { ok: boolean; data: DashboardState; hasForwardingTarget: boolean } | undefined;
let searchParams: { wabaId?: string } = {};

mock.module("@tanstack/react-router", () => ({
  Link: (props: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={props.to} className={props.className} data-testid="checklist-link">
      {props.children}
    </a>
  ),
  useLoaderData: () => loaderData,
  useSearch: () => searchParams,
}));

const { NavSetup } = await import("../src/components/blocks/app-shell-7/components/nav-setup");
const { setupComplete, setupSteps } = await import("../src/lib/setup-checklist");
function setupStepsOf(state: DashboardState, hasTarget: boolean) {
  return setupSteps(state, hasTarget);
}

function stateFor(stage: DashboardState["stage"], inbound = 0): DashboardState {
  const base = {
    resources: {
      account: { accountId: "account-a", name: "A", createdAt: 1 },
      keys: [],
      wabas: [] as never[],
    },
  };
  if (stage === "no-organization") {
    return { stage: "no-organization" } as DashboardState;
  }
  if (stage === "account-ready") {
    return { stage: "account-ready", ...base } as unknown as DashboardState;
  }
  // inbound 0: with a forwarding target the checklist must NOT be complete
  // (first message still todo) — a complete checklist hides itself, which is
  // pinned separately below.
  return {
    stage: "ready",
    ...base,
    status: { counts: { inbound, outbound: {}, deliveries: {} } },
    scope: {},
  } as unknown as DashboardState;
}

function renderFor(
  stage: DashboardState["stage"],
  hasForwardingTarget = false,
  inbound = 0,
): string {
  loaderData = { ok: true, data: stateFor(stage, inbound), hasForwardingTarget };
  searchParams = {};
  return renderToStaticMarkup(<NavSetup />);
}

describe("NavSetup rendering of the href contract", () => {
  test("a done workspace row is plain text, not a link", () => {
    // §2: the workspace row is always done when the shell renders, and linking
    // it to /onboarding handed the operator a duplicate-maker. The derivation
    // nulls the href (setup-checklist.test.ts); the renderer must draw text.
    const html = renderFor("account-ready");
    expect(html).toContain("Workspace");
    expect(html).not.toContain('href="/onboarding"');
  });

  test("recurring steps keep their links even when done", () => {
    // Only the workspace loses its door: numbers, target and message are
    // recurring actions, so a done row still links to its page.
    const html = renderFor("ready", true);
    expect(html).toContain('href="/numbers"');
    expect(html).toContain('href="/webhooks"');
    expect(html).toContain('href="/inbound"');
    expect(html).not.toContain('href="/onboarding"');
  });

  test("a todo workspace row (no-organization) links to /onboarding", () => {
    // The one live workspace link: a no-organization session has no shell pages
    // to link instead, and the root loader forces every route to /onboarding —
    // where creating the workspace IS the point of the page.
    const html = renderFor("no-organization");
    expect(html).toContain('href="/onboarding"');
  });

  test("the completed checklist hides itself, as before", () => {
    // Unchanged behavior, pinned so the null-href work cannot regress it: a
    // fully done checklist renders nothing at all.
    expect(setupComplete(setupStepsOf(stateFor("ready", 1), true))).toBe(true);
    expect(renderFor("ready", true, 1)).toBe("");
  });
});
