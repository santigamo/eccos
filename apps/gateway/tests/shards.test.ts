import { expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shards, weight } from "./shards";

// CI runs the Workers suite as `vitest run --shard=i/n` jobs (vitest.config.ts): together they
// must run every spec file exactly once, at about the same length.

const specs = readdirSync(fileURLToPath(new URL("./worker/", import.meta.url))).filter((f) => f.endsWith(".spec.ts"));

it.each([2, 3, 4])("%i shards run every spec file once, in about equal time", (count) => {
  const split = shards(specs, count, (f) => f);
  expect(split.flat().sort()).toEqual([...specs].sort());

  const totals = split.map((files) => files.reduce((sum, f) => sum + weight(f), 0));
  const even = totals.reduce((a, b) => a + b) / count;
  expect(Math.max(...totals)).toBeLessThan(even * 1.1);
});

it("the split does not depend on the order the files are listed in", () => {
  expect(shards([...specs].reverse(), 3, (f) => f)).toEqual(shards(specs, 3, (f) => f));
});
