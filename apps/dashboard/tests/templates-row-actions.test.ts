import { describe, expect, test } from "bun:test";

/**
 * Two defects the /templates row actions shipped with, both of them invisible
 * to a static render and both caught by opening the real page in production:
 * the Delete item drew the surface red as text, and the row click opened the
 * preview and closed it in the same gesture.
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
 * The row-click / outside-press collision (eccos-pxr), pinned here because it
 * is the same class of defect as the ink above: invisible to a static render,
 * and it reached production.
 *
 * A `<tr onClick>` that mounts an overlay hands the click on to the document,
 * where the overlay's own outside-press listener — registered while that very
 * click was still propagating — reads it as a dismissal. /templates shipped
 * with the preview opening and closing in one gesture: the row looked inert
 * while the NAME cell beside it worked, because the name button already
 * stopped its own click.
 *
 * `renderToStaticMarkup` produces no events and Base UI renders a closed sheet
 * as nothing, so the guard itself is unreachable at runtime here — the shape of
 * the call is what gets pinned.
 */
describe("row click that opens an overlay", () => {
  test("the grid hands the event to onRowClick", async () => {
    const table = await Bun.file(
      new URL("../src/components/reui/data-grid/data-grid-table.tsx", import.meta.url),
    ).text();
    expect(table).toContain("props.onRowClick(row.original, event)");
  });

  test("/templates stops the click before it reaches the document", async () => {
    const route = await Bun.file(
      new URL("../src/routes/templates.tsx", import.meta.url),
    ).text();
    expect(route).toMatch(/onRowClick=\{\(row, event\) => \{\s*event\.stopPropagation\(\);/);
  });
});
