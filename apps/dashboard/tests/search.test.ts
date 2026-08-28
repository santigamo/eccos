import { describe, expect, test } from "bun:test";
import { normalizeSearchBefore, normalizeSearchStatus, normalizeSearchWabaId } from "../src/lib/search";

describe("dashboard search normalization", () => {
  test("keeps valid WABA ids and drops malformed values", () => {
    expect(normalizeSearchWabaId(" WABA_123 ")).toBe("WABA_123");
    expect(normalizeSearchWabaId("WABA/123")).toBeUndefined();
    expect(normalizeSearchWabaId(" ")).toBeUndefined();
    expect(normalizeSearchWabaId(123)).toBeUndefined();
  });

  test("keeps bounded statuses and drops oversized or empty values", () => {
    expect(normalizeSearchStatus(" failed ")).toBe("failed");
    expect(normalizeSearchStatus(" ")).toBeUndefined();
    expect(normalizeSearchStatus("x".repeat(101))).toBeUndefined();
  });

  test("keeps safe pagination cursors and drops malformed values", () => {
    expect(normalizeSearchBefore("42")).toBe(42);
    expect(normalizeSearchBefore("1.5")).toBeUndefined();
    expect(normalizeSearchBefore("9007199254740992")).toBeUndefined();
    expect(normalizeSearchBefore(true)).toBeUndefined();
  });
});
