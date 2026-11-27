import { basename } from "node:path";
import durations from "./worker-durations.json";

// The milliseconds CI's vitest reporter printed for each spec file. Refresh them from a CI log when
// a file is added or gets much slower; a file not listed counts as a typical one.
const recorded: Record<string, number> = durations;
const typical = Object.values(recorded).sort((a, b) => a - b)[Math.floor(Object.keys(recorded).length / 2)]!;

// On top of its tests, every file imports the worker afresh: about 1.3s on a CI runner.
const IMPORT_MS = 1300;

/** How long a spec file is expected to take on CI. */
export const weight = (file: string): number => IMPORT_MS + (recorded[basename(file)] ?? typical);

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
