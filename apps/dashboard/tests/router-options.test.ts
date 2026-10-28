import { describe, expect, test } from "bun:test";

/**
 * The router's pending contract (eccos-msz) — four decisions that would be
 * silently undone by a well-meaning edit, and that no other test can see.
 *
 * WHY THIS READS SOURCE INSTEAD OF CALLING `getRouter()`. It did, and it broke
 * six unrelated tests. `bun test` runs every file in ONE process with ONE
 * module registry, in an order that is not alphabetical and not ours to
 * choose; importing `src/router` pulls in the generated route tree, which
 * evaluates `src/routes/*.tsx` against the REAL `createFileRoute`. The screen
 * tests (`templates-screen`, `numbers-screen`, …) render those same modules
 * after stubbing `createFileRoute` so the route object hands back their
 * fixtures — and a module already cached from the real load hands them a real
 * Route whose `.component` is undefined instead. Whichever file happened to
 * run first won.
 *
 * So the rule this file lives under: NOTHING under tests/ may import the app
 * router or the route tree. What it costs is that these are textual
 * assertions; what it buys is that deleting a `pendingComponent` still fails a
 * test, which is the regression that matters.
 */

const routerSource = await Bun.file(
  new URL("../src/router.tsx", import.meta.url),
).text();

describe("router pending options", () => {
  test("a route's skeleton waits for a load the rail alone can no longer carry", () => {
    // TanStack's own default is 1000ms, which leaves most gateway round trips
    // showing the PREVIOUS page's rows under the new sidebar highlight. Below
    // ~300ms, though, a fresh read usually lands, and a skeleton armed sooner
    // only adds its minimum on top — so the rail owns that window alone.
    expect(routerSource).toContain("defaultPendingMs: 300");
    // And a skeleton that did reach the screen stays long enough to be read.
    expect(routerSource).toContain("defaultPendingMinMs: 200");
  });

  test("no default pending component — it would blank the whole app shell", () => {
    // THE LOAD-BEARING ABSENCE. The timeout that promotes a match to its
    // pending view is only armed for routes that HAVE one. A default arms it
    // for the ROOT match too, whose component is the entire chrome — so a slow
    // root load would replace the sidebar, the masthead and the page with a
    // skeleton instead of filling the page inside them.
    expect(routerSource).not.toContain("defaultPendingComponent:");
  });
});

describe("router reuse policy", () => {
  test("hover and focus preload, after a short delay, and a preload serves the click", () => {
    expect(routerSource).toContain('defaultPreload: "intent"');
    expect(routerSource).toContain("defaultPreloadDelay: 50");
    expect(routerSource).toContain("defaultPreloadStaleTime: 30_000");
  });

  test("no global staleTime: each route says how long its data lives", () => {
    expect(routerSource).not.toContain("defaultStaleTime");
  });

  test("live lists stay fresh 5s, configuration 30s", async () => {
    const policy = await Bun.file(new URL("../src/lib/route-stale.ts", import.meta.url)).text();
    expect(policy).toContain("LIVE_STALE_MS = 5_000");
    expect(policy).toContain("CONFIG_STALE_MS = 30_000");
    const expected = {
      conversations: "LIVE",
      messages: "LIVE",
      events: "LIVE",
      deliveries: "LIVE",
      settings: "CONFIG",
      templates: "CONFIG",
      webhooks: "CONFIG",
    };
    for (const [route, kind] of Object.entries(expected)) {
      const source = await Bun.file(new URL(`../src/routes/${route}.tsx`, import.meta.url)).text();
      expect(source).toContain(`staleTime: ${kind}_STALE_MS`);
    }
  });

  test("the root route is never given a staleTime: scope state is re-read on every navigation", async () => {
    const source = await Bun.file(new URL("../src/routes/__root.tsx", import.meta.url)).text();
    expect(source).not.toContain("staleTime");
  });
});

describe("per-route pending views", () => {
  test("every log route can show its own structure while it loads", async () => {
    // Each of these crosses the RPC service binding to the gateway on entry,
    // which is exactly the wait that used to render as the wrong page's rows.
    for (const route of ["templates", "deliveries", "messages", "events"]) {
      const source = await Bun.file(
        new URL(`../src/routes/${route}.tsx`, import.meta.url),
      ).text();
      expect(source).toContain("pendingComponent:");
      expect(source).toContain("<GridPending");
    }
  });

  test("every other route that loads its own data has one too", async () => {
    for (const route of ["conversations", "settings", "webhooks"]) {
      const source = await Bun.file(
        new URL(`../src/routes/${route}.tsx`, import.meta.url),
      ).text();
      expect(source).toContain("pendingComponent:");
    }
  });

  test("the root route has none, on purpose", async () => {
    const source = await Bun.file(
      new URL("../src/routes/__root.tsx", import.meta.url),
    ).text();
    expect(source).not.toContain("pendingComponent");
  });
});
