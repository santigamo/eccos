import { describe, expect, test } from "bun:test";

/**
 * How the /templates row is laid out — the three things about it that no
 * static render can see, and that were therefore only found by opening the
 * real page.
 *
 * The component-level colour and hover rules this row depends on live in
 * `tests/interaction-contrast.test.ts`; what is pinned here is the geometry
 * that belongs to this route.
 */

const route = await Bun.file(
  new URL("../src/routes/templates.tsx", import.meta.url),
).text();

describe("the kebab shield", () => {
  // The kebab sits inside a `<tr onClick>` that opens the preview, so it stops
  // its own click — correct. But the shield around it was `flex justify-end`,
  // and this column takes what is left of the table, so it stretched across
  // everything right of Status and ate every row click that landed there. The
  // row looked inert over half its width while the name cell, well outside the
  // shield, worked fine.
  //
  // (The first theory was that the sheet dismissed itself on the opening click.
  // It cannot: Base UI registers outside-press on `document` in the CAPTURE
  // phase — `floating-ui-react/hooks/useDismiss.js` — so that listener does not
  // exist yet when the click passes, and never sees it.)
  test("covers the trigger, not the column", () => {
    const shield = route.slice(route.indexOf("<span\n      className="));
    expect(shield.slice(0, 60)).toContain('className="inline-flex"');
    expect(shield.slice(0, 60)).not.toContain("justify-end");
  });

  test("the row handler stays plain — nothing to stop", () => {
    expect(route).toContain("onRowClick={openPreview}");
  });
});

describe("column widths", () => {
  test("the data columns are sized in proportion, so the table fills its panel", () => {
    // `table-auto` sizes a column to its content and hands the rest to whoever
    // asks. With four columns of short values — a name, a two-letter language,
    // a tag — that put the whole page in a strip down the left quarter with a
    // thousand pixels of nothing beside it. The other log views never show this
    // because they carry seven columns of timestamps and ids.
    //
    // Percentages, not fixed widths, so the split survives a laptop and a wide
    // monitor.
    expect(route).toContain('const NAME_WIDTH = "w-[');
    expect(route).toContain('const LANGUAGE_WIDTH = "w-[');
    expect(route).toContain('const STATUS_WIDTH = "w-[');
    for (const line of route.split("\n")) {
      if (line.includes("_WIDTH = ")) expect(line).toContain("%]");
    }
  });

  test("the action column stays unsized and keeps the kebab at the edge", () => {
    // Sizing it too would leave the leftover with nowhere to go and put the
    // kebab back in the middle of the row.
    const action = route.slice(route.indexOf('id: "action"'));
    expect(action.slice(0, 1600)).not.toContain("w-[");
  });

  test("the pending view carries the same four columns", () => {
    // Otherwise the three real columns stretch across the full width while the
    // loader runs and snap back the moment the rows land. A skeleton that
    // predicts a different layout from the one replacing it is worse than none.
    const pending = route.slice(route.indexOf("const pendingColumns"));
    expect(pending.slice(0, 400)).toContain("nameColumn()");
    expect(pending.slice(0, 400)).toContain("languageColumn");
    expect(pending.slice(0, 400)).toContain("statusColumn");
    expect(pending.slice(0, 400)).toContain('id: "action"');
  });
});
