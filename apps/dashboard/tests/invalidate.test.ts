import { describe, expect, test } from "bun:test";
import { invalidatePage, invalidateRoutes } from "../src/lib/invalidate";

const ids = ["__root__", "/events", "/webhooks", "/numbers"];

function router() {
  const calls: Array<(m: { routeId: string }) => boolean> = [];
  return {
    invalidate: async (opts: { filter: (m: { routeId: string }) => boolean }) => void calls.push(opts.filter),
    matched: () => ids.filter((routeId) => calls.at(-1)!({ routeId })),
  };
}

describe("targeted invalidation", () => {
  test("pages (polling, retries, sends, template writes) never reload the root", async () => {
    const r = router();
    await invalidatePage(r);
    expect(r.matched()).toEqual(["/events", "/webhooks", "/numbers"]);
  });

  test("root-changing events name the root", async () => {
    const r = router();
    await invalidateRoutes(r, "__root__");
    expect(r.matched()).toEqual(["__root__"]);
  });

  test("a forwarding edit reloads its page and the root that carries the flag", async () => {
    const r = router();
    await invalidateRoutes(r, "/webhooks", "__root__");
    expect(r.matched()).toEqual(["__root__", "/webhooks"]);
  });
});
