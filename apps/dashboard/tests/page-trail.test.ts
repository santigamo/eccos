import { describe, expect, test } from "bun:test";

import { normalizeSearchTrail, pageOfRows, pagerState } from "../src/lib/page-trail";

describe("pagerState", () => {
  test("the first page has no way back and starts the trail", () => {
    expect(pagerState(undefined, undefined, 50)).toEqual({
      page: 1,
      previous: undefined,
      next: { cursor: 50, trail: [null] },
    });
  });

  test("page two goes back to the first page, which has no cursor", () => {
    expect(pagerState(50, [null], 25)).toEqual({
      page: 2,
      previous: { cursor: undefined, trail: undefined },
      next: { cursor: 25, trail: [null, 50] },
    });
  });

  test("a deeper page pops one step", () => {
    const state = pagerState(25, [null, 50], null);
    expect(state.page).toBe(3);
    expect(state.previous).toEqual({ cursor: 50, trail: [null] });
    expect(state.next).toBeUndefined();
  });

  test("a cursor without its trail claims no page number and no way back", () => {
    expect(pagerState(50, undefined, 25)).toEqual({
      page: undefined,
      previous: undefined,
      next: { cursor: 25, trail: undefined },
    });
  });

  test("string cursors walk the same way", () => {
    expect(pagerState("b", [null, "a"], "c").next).toEqual({ cursor: "c", trail: [null, "a", "b"] });
  });
});

describe("normalizeSearchTrail", () => {
  test("accepts a trail that starts at the first page", () => {
    expect(normalizeSearchTrail([null, 50, "x"], 25)).toEqual([null, 50, "x"]);
  });

  test("drops a trail on the first page", () => {
    expect(normalizeSearchTrail([null], undefined)).toBeUndefined();
  });

  test("drops anything that is not a trail", () => {
    expect(normalizeSearchTrail("nope", 25)).toBeUndefined();
    expect(normalizeSearchTrail([], 25)).toBeUndefined();
    expect(normalizeSearchTrail([50], 25)).toBeUndefined();
    expect(normalizeSearchTrail([null, { a: 1 }], 25)).toBeUndefined();
    expect(normalizeSearchTrail([null, "x".repeat(129)], 25)).toBeUndefined();
  });
});

describe("pageOfRows", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 100 - i }));

  test("an exact page has no next page", () => {
    const page = pageOfRows(rows(50), 50);
    expect(page.rows).toHaveLength(50);
    expect(page.nextCursor).toBeNull();
  });

  test("one extra row means a next page, cursored on the last row shown", () => {
    const page = pageOfRows(rows(51), 50);
    expect(page.rows).toHaveLength(50);
    expect(page.nextCursor).toBe(51);
  });

  test("an empty read has no next page", () => {
    expect(pageOfRows([], 50)).toEqual({ rows: [], nextCursor: null });
  });
});
