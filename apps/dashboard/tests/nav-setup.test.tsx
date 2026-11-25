import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardState } from "../src/server/gateway";
import type { CompanionBilling } from "../src/lib/setup-checklist";

/**
 * The sidebar setup companion (`nav-setup.tsx`). The derivation is pinned in
 * `tests/setup-checklist.test.ts`; what is pinned here is the rendering: the
 * href contract, the current step, the hide rule and the billing seam.
 *
 * `NavSetup` reads the root loader and search params through TanStack Router
 * hooks, so the router module is stubbed before the import and the state is
 * fed directly. `renderToStaticMarkup` needs no DOM.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

let loaderData: { ok: boolean; data: DashboardState; hasForwardingTarget: boolean | null } | undefined;
let searchParams: { wabaId?: string } = {};

// SPREAD, not replaced: the first stub for a specifier fixes which keys exist
// for the whole process, so a partial stub strips exports later files need.
const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  Link: (props: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
  useLoaderData: () => loaderData,
  useSearch: () => searchParams,
}));

const { NavSetup } = await import("../src/components/blocks/app-shell-7/components/nav-setup");

function stateFor(stage: DashboardState["stage"], replies = 0): DashboardState {
  const resources = {
    account: { accountId: "account-a", name: "A", createdAt: 1 },
    keys: [],
    wabas: [],
    phones: [],
  };
  if (stage === "no-organization") return { stage: "no-organization" } as DashboardState;
  if (stage === "account-ready") return { stage: "account-ready", resources } as unknown as DashboardState;
  return {
    stage: "ready",
    status: {
      counts: { inbound: replies, inboundByType: { reply: replies }, outbound: {}, deliveries: {} },
    },
    scope: { resources },
  } as unknown as DashboardState;
}

function renderFor(
  stage: DashboardState["stage"],
  hasForwardingTarget: boolean | null = false,
  replies = 0,
  billing?: CompanionBilling,
): string {
  loaderData = { ok: true, data: stateFor(stage, replies), hasForwardingTarget };
  searchParams = {};
  return renderToStaticMarkup(<NavSetup billing={billing} />);
}

describe("NavSetup companion", () => {
  test("counts what is done and marks the current step", () => {
    const html = renderFor("account-ready");
    expect(html).toContain("1 of 4");
    // The current step is the first one not done, announced as such.
    expect(html).toMatch(/<li aria-current="step"[^>]*>.*Number/);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain("Webhook or API key");
    expect(html).toContain("First message");
  });

  test("a done workspace row is plain text, not a link", () => {
    const html = renderFor("account-ready");
    expect(html).toContain("Workspace");
    expect(html).not.toContain('href="/onboarding"');
  });

  test("recurring steps keep their links even when done", () => {
    const html = renderFor("ready", true);
    expect(html).toContain('href="/numbers"');
    expect(html).toContain('href="/setup"');
    expect(html).toContain('href="/events"');
    expect(html).not.toContain('href="/onboarding"');
  });

  test("a todo workspace row (no-organization) links to /onboarding", () => {
    expect(renderFor("no-organization")).toContain('href="/onboarding"');
  });

  test("keeps the Hide action", () => {
    expect(renderFor("ready")).toContain(">Hide</button>");
  });

  test("hides itself once every observable step is done", () => {
    expect(renderFor("ready", true, 1)).toBe("");
  });

  test("a target read that failed does not reopen the setup step", () => {
    // `null` is unknown, never "no target".
    expect(renderFor("ready", null, 1)).toBe("");
    expect(renderFor("ready", false, 1)).toContain("Webhook or API key");
  });

  test("billing, once fed, decides: paid hides, activated keeps it up", () => {
    expect(renderFor("ready", false, 0, { stage: "paid" })).toBe("");
    expect(renderFor("ready", true, 1, { stage: "activated", hoursLeft: 72 })).toContain("Setup");
  });

  test("shows the hours left once activated, and the pause", () => {
    expect(renderFor("ready", true, 1, { stage: "activated", hoursLeft: 41 })).toContain("Activated · 41 hours left to subscribe");
    expect(renderFor("ready", true, 1, { stage: "activated", hoursLeft: 1 })).toContain("1 hour left");
    expect(renderFor("ready", true, 1, { stage: "paused" })).toContain("Paused · subscribe to send again");
    expect(renderFor("ready", false, 0)).not.toContain("left to subscribe");
  });
});
