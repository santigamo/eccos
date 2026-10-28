import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The root guards moved out of the loader into a per-navigation `beforeLoad`
 * that decides from the root's held snapshot (no request) and awaits one read
 * only for a new scope or an invalidated root.
 */
installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { rootRedirect, Route } = await import("../src/routes/__root");

type State = Parameters<typeof rootRedirect>[1];
const noOrg = { ok: true, data: { stage: "no-organization" } } as State;
const accountReady = {
  ok: true,
  data: { stage: "account-ready", resources: { account: null, wabas: [{ wabaId: "w1" }] } },
} as unknown as State;
const accountReadyNoWaba = {
  ok: true,
  data: { stage: "account-ready", resources: { account: null, wabas: [] } },
} as unknown as State;
const ready = { ok: true, data: { stage: "ready" } } as unknown as State;

describe("rootRedirect (per stage)", () => {
  test("no-organization is sent to /onboarding from anywhere else, and stays there", () => {
    expect(rootRedirect("/events", noOrg)).toBe("/onboarding");
    expect(rootRedirect("/", noOrg)).toBe("/onboarding");
    expect(rootRedirect("/onboarding", noOrg)).toBeUndefined();
  });

  test("account-ready leaves /onboarding and is bounced from pages that need a number", () => {
    expect(rootRedirect("/onboarding", accountReady)).toBe("/");
    expect(rootRedirect("/events", accountReady)).toBe("/numbers");
    expect(rootRedirect("/templates", accountReady)).toBeUndefined();
    expect(rootRedirect("/templates", accountReadyNoWaba)).toBe("/numbers");
    expect(rootRedirect("/numbers", accountReadyNoWaba)).toBeUndefined();
  });

  test("ready reaches every page, but not /onboarding", () => {
    expect(rootRedirect("/events", ready)).toBeUndefined();
    expect(rootRedirect("/onboarding", ready)).toBe("/");
  });

  test("a failed read never redirects", () => {
    expect(rootRedirect("/events", { ok: false } as unknown as State)).toBeUndefined();
  });
});

describe("root beforeLoad", () => {
  const options = Route.options as unknown as { beforeLoad: (ctx: unknown) => unknown };
  const rootMatch = (over: object) => ({ routeId: "__root__", status: "success", invalid: false, ...over });
  const run = (pathname: string, match: object, read: () => Promise<State>) =>
    options.beforeLoad({
      context: { bootstrap: { read } },
      location: { pathname },
      matches: [match],
      search: {},
    });
  const never = () => {
    throw new Error("must not read");
  };
  const redirectTarget = (error: unknown) => (error as { options?: { to?: string } })?.options?.to;

  test("a held, valid snapshot decides synchronously with no read", () => {
    expect(() => run("/events", rootMatch({ loaderData: ready }), never)).not.toThrow();
    let thrown: unknown;
    try {
      run("/events", rootMatch({ loaderData: noOrg }), never);
    } catch (error) {
      thrown = error;
    }
    expect(redirectTarget(thrown)).toBe("/onboarding");
  });

  test("a new scope or an invalidated root awaits exactly one read", async () => {
    for (const match of [rootMatch({ status: "pending" }), rootMatch({ loaderData: ready, invalid: true })]) {
      let reads = 0;
      const result = run("/events", match, async () => {
        reads++;
        return noOrg;
      }) as Promise<void>;
      await result.then(
        () => {
          throw new Error("expected a redirect");
        },
        (error) => expect(redirectTarget(error)).toBe("/onboarding"),
      );
      expect(reads).toBe(1);
    }
  });

  test("the root is reused for 30s and never given shouldReload", () => {
    expect(Route.options.staleTime).toBe(30_000);
    expect(Route.options.preloadStaleTime).toBe(30_000);
    expect((Route.options as { shouldReload?: unknown }).shouldReload).toBeUndefined();
  });
});
