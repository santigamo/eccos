import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The /onboarding guard (eccos-vye, console-gaps §1).
 *
 * `__root.tsx` guards the route with a single pure decision,
 * `onboardingWorkspaceCreated(stage)`. The loader's two branches read the same
 * helper: when a workspace already exists, landing on /onboarding redirects to
 * `/`; when it does not (and the path is not already /onboarding), the loader
 * sends the session there instead.
 *
 * The decision is pinned here without a browser, exactly because it is tiny: the
 * regression that started this bead was the guard firing for `ready` only, while
 * `account-ready` (workspace exists, no active number yet) silently rendered the
 * first-run form and offered to create a duplicate workspace. The histories of
 * the "reaches the page" versus "redirects" branches must be the histories of
 * this helper, and a stage added later must choose a side explicitly.
 */

// `__root.tsx` pulls in the gateway and organization server functions at module
// level, so the runtime shims must be installed before the route module
// evaluates — the same requirement every other test with a src import has. The
// helper itself reads nothing from those; it is a pure function of its stage.
installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { onboardingWorkspaceCreated } = await import("../src/routes/__root");

describe("onboardingWorkspaceCreated (the /onboarding guard)", () => {
  test("redirect fires in `ready` — the stage that always did", () => {
    expect(onboardingWorkspaceCreated("ready")).toBe(true);
  });

  test("redirect fires in `account-ready` — the stage that silently slipped through", () => {
    // A workspace exists (the membership resolved), so /onboarding must not be
    // able to offer a duplicate — even while the account still has no active
    // number. This is the regression the bead fixes: it used to be
    // `stage === "ready"`, and `account-ready` fell through to the form.
    expect(onboardingWorkspaceCreated("account-ready")).toBe(true);
  });

  test("`no-organization` still reaches the page", () => {
    // First run: nothing created, so the guard does not fire and the loader can
    // serve the onboarding form (or push a session onto it from any other path).
    expect(onboardingWorkspaceCreated("no-organization")).toBe(false);
  });

  test("`unassigned` counts as having a workspace", () => {
    // A stage the gateway never returns today (getDashboardState resolves to
    // no-organization / account-ready / ready), kept in the union. By
    // construction it is NOT `no-organization`, so it is on the redirect side —
    // pinned here so an assignment-based stage cannot silently reopen the form.
    expect(onboardingWorkspaceCreated("unassigned")).toBe(true);
  });
});