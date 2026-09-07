import { describe, expect, test } from "bun:test";

/**
 * The select popup's readability floor, and the call-site override that
 * removed it on /deliveries.
 *
 * `w-(--anchor-width)` sizes the popup to the trigger, which for a two-word
 * filter reading "all" is 55px — narrower than every option inside it.
 * `min-w-36` is what saves that case. A call site passing its own `min-w-*`
 * REPLACES it (tailwind-merge reads both as the same key), and the one that
 * shipped passed `min-w-(--anchor-width)`: it added nothing the width was not
 * already doing, and it dropped the floor, so the list rendered at 55px with
 * every option clipped mid-word.
 *
 * Read from source because an open Base UI popup lives in a portal that a
 * static render never produces.
 */

const select = await Bun.file(
  new URL("../src/components/ui/select.tsx", import.meta.url),
).text();

describe("select popup width", () => {
  test("the component keeps a minimum width the anchor cannot undercut", () => {
    const popup = select.slice(select.indexOf('data-slot="select-content"'));
    expect(popup.slice(0, 900)).toMatch(/min-w-\d/);
    expect(popup.slice(0, 900)).toContain("w-(--anchor-width)");
  });

  test("no call site trades that floor for the anchor width", async () => {
    const offenders: string[] = [];
    for await (const file of new Bun.Glob("**/*.tsx").scan({
      cwd: new URL("../src", import.meta.url).pathname,
      absolute: true,
    })) {
      if (file.endsWith("/ui/select.tsx")) continue;
      const source = await Bun.file(file).text();
      if (/<SelectContent[^>]*min-w-/.test(source)) {
        offenders.push(file.slice(file.indexOf("/src/") + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the deliveries filter opens inward from the page's right edge", async () => {
    const route = await Bun.file(
      new URL("../src/routes/deliveries.tsx", import.meta.url),
    ).text();
    expect(route).toContain('<SelectContent align="end">');
  });

  test("its trigger holds one width and says what the menu says", async () => {
    // `w-fit` made the console's one header control re-flow on every use, and
    // the raw value read "all" while the menu it opens says "all statuses".
    const route = await Bun.file(
      new URL("../src/routes/deliveries.tsx", import.meta.url),
    ).text();
    const trigger = route.slice(route.indexOf("<SelectTrigger"));
    expect(trigger.slice(0, 200)).toMatch(/className="w-\d/);
    expect(route).toContain('value === "all" ? "all statuses" : value');
  });
});
