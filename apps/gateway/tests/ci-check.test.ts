import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// CI splits `bun run check` into parallel jobs. Both must run the same steps, or a
// green local check could still fail in CI (or CI could skip a step the check runs).

const root = fileURLToPath(new URL("../../../", import.meta.url));
const scripts: Record<string, string> = JSON.parse(readFileSync(`${root}package.json`, "utf8")).scripts;

/** A script made only of `bun run` steps expands to their steps; any other script is one step. */
function steps(script: string): string[] {
  const parts = scripts[script]!.split(" && ");
  if (!parts.every((part) => part.startsWith("bun run "))) return [script];
  return parts.flatMap((part) => steps(part.slice("bun run ".length)));
}

it("CI runs every step of bun run check, once", () => {
  const ci = readFileSync(`${root}.github/workflows/ci.yml`, "utf8");
  // A sharded step runs its script once across the matrix: each job takes one --shard of it.
  const shard = " --shard=${{ matrix.shard }}/${{ strategy.job-total }}";
  const ciSteps = [...ci.matchAll(/^\s+(?:- )?run: bun run (\S+)(.*)$/gm)].flatMap((m) => {
    if (m[2] && m[2] !== shard) throw new Error(`CI step passes arguments a local check does not: ${m[0]}`);
    return steps(String(m[1]));
  });
  expect(ciSteps.sort()).toEqual(steps("check").sort());
});
