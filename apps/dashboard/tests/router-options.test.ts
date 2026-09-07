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
    // ~350ms, though, swapping a table out and back reads as a flash — so the
    // rail owns that window alone and the skeleton takes over past it.
    expect(routerSource).toContain("defaultPendingMs: 350");
    // And a skeleton that did reach the screen stays long enough to be read.
    expect(routerSource).toContain("defaultPendingMinMs: 400");
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

describe("per-route pending views", () => {
  test("every log route can show its own structure while it loads", async () => {
    // Each of these crosses the RPC service binding to the gateway on entry,
    // which is exactly the wait that used to render as the wrong page's rows.
    for (const route of ["templates", "deliveries", "inbound", "outbound"]) {
      const source = await Bun.file(
        new URL(`../src/routes/${route}.tsx`, import.meta.url),
      ).text();
      expect(source).toContain("pendingComponent:");
      expect(source).toContain("<GridPending");
    }
  });

  test("the root route has none, on purpose", async () => {
    const source = await Bun.file(
      new URL("../src/routes/__root.tsx", import.meta.url),
    ).text();
    expect(source).not.toContain("pendingComponent");
  });
});
