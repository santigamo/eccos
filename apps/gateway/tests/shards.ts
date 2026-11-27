import { basename } from "node:path";
import durations from "./worker-durations.json";

// Milliseconds each spec file took in one full run. Refresh it when a file is added or gets much
// slower: `vitest run --reporter=json --outputFile=r.json`, then each file's endTime - startTime.
const recorded: Record<string, number> = durations;
const typical = Object.values(recorded).sort((a, b) => a - b)[Math.floor(Object.keys(recorded).length / 2)]!;

/** How long a spec file is expected to take; a file not recorded yet counts as a typical one. */
export const weight = (file: string): number => recorded[basename(file)] ?? typical;

/**
 * Splits files into `count` shards of about equal duration: longest first, each into the lightest
 * shard so far. Depends only on the file names, so every CI job computes the same split.
 */
export function shards<T>(files: T[], count: number, name: (file: T) => string): T[][] {
  const out = Array.from({ length: count }, () => ({ total: 0, files: [] as T[] }));
  const order = [...files].sort(
    (a, b) => weight(name(b)) - weight(name(a)) || (basename(name(a)) < basename(name(b)) ? -1 : 1),
  );
  for (const file of order) {
    const lightest = out.reduce((min, shard) => (shard.total < min.total ? shard : min));
    lightest.files.push(file);
    lightest.total += weight(name(file));
  }
  return out.map((shard) => shard.files);
}
