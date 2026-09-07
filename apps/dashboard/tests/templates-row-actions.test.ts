import { describe, expect, test } from "bun:test";

/**
 * Two defects the /templates row actions shipped with, both of them invisible
 * to a static render and both caught by opening the real page in production:
 * the Delete item drew the surface red as text, and the kebab's click shield
 * stretched across the whole action column, swallowing the row click.
 *
 * ── THE INK ─────────────────────────────────────────────────────────────────
 *
 * THE TOKEN CONTRACT (docs/DASHBOARD-DESIGN.md). `--destructive` (#e03131) is
 * a SURFACE colour. As text on this console's dark ground it lands at ~3.9:1,
 * under the 4.5:1 floor, so destructive TEXT is always
 * `--destructive-foreground` (#ff7777). The 10%/20% focus washes keep
 * `--destructive`, because a wash is a surface.
 *
 * WHY THE FIX HAD TO GO IN THE COMPONENT. The vendored item ships
 * `data-[variant=destructive]:text-destructive`. Overriding that from a call
 * site with `className="text-destructive-foreground"` looks right and does
 * nothing: the variant-prefixed utility carries an attribute selector and wins
 * on specificity, and tailwind-merge does not treat the prefixed and
 * unprefixed classes as the same key, so it never drops the loser. The
 * /templates Delete item shipped that way and rendered rgb(224, 49, 49) in
 * production.
 *
 * WHY THIS READS SOURCE. A Base UI menu item cannot be rendered outside
 * `<Menu.Root>` ("MenuRootContext is missing"), and an open menu lives in a
 * portal that a static render never produces — so the class string itself is
 * the only reachable surface for this assertion.
 */

const source = await Bun.file(
  new URL("../src/components/ui/dropdown-menu.tsx", import.meta.url),
).text();

describe("DropdownMenuItem destructive ink", () => {
  test("destructive text uses the foreground token, never the surface one", () => {
    expect(source).toContain("data-[variant=destructive]:text-destructive-foreground");
    expect(source).toContain(
      "data-[variant=destructive]:focus:text-destructive-foreground",
    );
  });

  test("no bare --destructive is left as ink", () => {
    // `text-destructive` followed by anything other than `-foreground`. The
    // background utilities (`focus:bg-destructive/10`) are deliberately spared.
    const inkAsSurface = /text-destructive(?!-foreground)/.exec(source);
    expect(inkAsSurface).toBeNull();
  });

  test("the focus wash stays on the surface colour", () => {
    // Not an oversight: a 10% fill is a surface, and swapping it would lose
    // the red the focused row is supposed to read as.
    expect(source).toContain("data-[variant=destructive]:focus:bg-destructive/10");
  });
});

/**
 * The row-click dead zone (eccos-pxr), the second regression this change
 * shipped and the second one only a real pointer could find.
 *
 * The kebab sits inside a `<tr onClick>` that opens the preview, so it stops
 * its own click — correct. But the shield around it was `flex justify-end` in
 * the column that takes the TABLE'S SLACK, so it stretched across everything
 * right of Status and ate every row click that landed there. The row looked
 * inert over half its width while the name cell, well outside the shield,
 * worked fine.
 *
 * (The first theory was that the sheet dismissed itself on the opening click.
 * It cannot: Base UI registers outside-press on `document` in the CAPTURE
 * phase — `useDismiss.js` — so that listener does not exist yet when the click
 * passes, and it never sees it.)
 */
describe("the kebab shield", () => {
  test("covers the trigger, not the column", async () => {
    const route = await Bun.file(
      new URL("../src/routes/templates.tsx", import.meta.url),
    ).text();
    const shield = route.slice(route.indexOf("<span\n      className="));
    expect(shield.slice(0, 60)).toContain('className="inline-flex"');
    expect(shield.slice(0, 60)).not.toContain("justify-end");
  });

  test("the row handler stays plain — nothing to stop", async () => {
    const route = await Bun.file(
      new URL("../src/routes/templates.tsx", import.meta.url),
    ).text();
    expect(route).toContain("onRowClick={openPreview}");
  });
});
