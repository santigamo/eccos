import { expect, test } from "bun:test";
import { isReseller } from "../src/billing/reseller";

test("a listed user is a reseller, matched exactly and ignoring spaces", () => {
  expect(isReseller("u1", "u1")).toBe(true);
  expect(isReseller("u2", " u1 , u2 ")).toBe(true);
  expect(isReseller("u1x", "u1")).toBe(false);
  expect(isReseller("u1", undefined)).toBe(false);
  expect(isReseller("", ",")).toBe(false);
});
