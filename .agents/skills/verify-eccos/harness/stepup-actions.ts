// Lists the console server functions that need a step-up, read from the source, and
// checks that features/step-up.md has a row for each (see ../SKILL.md, "Drive").
// A function needs one when it names a row of STEP_UP_ROWS, calls requireStepUp, or calls
// a helper in its file that calls requireStepUp. Usage, run by verify-eccos stepup-actions:
//   bun stepup-actions.ts            print "<file> <export>" per protected function
//   bun stepup-actions.ts --check    also fail when step-up.md lacks one, or names one too many
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dashboard = join(here, "../../../../apps/dashboard");
const stepUp = readFileSync(join(dashboard, "src/auth/step-up.ts"), "utf8");
const rowsBlock = stepUp.match(/STEP_UP_ROWS = \{([\s\S]*?)\}/)?.[1];
if (!rowsBlock) throw new Error("STEP_UP_ROWS not found in apps/dashboard/src/auth/step-up.ts");
const rows = [...rowsBlock.matchAll(/^\s*"?([a-z-]+)"?:/gm)].map((m) => String(m[1]));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const found: string[] = [];
for (const path of files(join(dashboard, "src"))) {
  const source = readFileSync(path, "utf8");
  if (!source.includes("createServerFn")) continue;
  const helpers = [...source.matchAll(/^(?:async )?function (\w+)\([\s\S]*?^\}/gm)]
    .filter((m) => m[0].includes("requireStepUp("))
    .map((m) => String(m[1]));
  const starts = [...source.matchAll(/^export const (\w+) = createServerFn\(/gm)];
  starts.forEach((start, i) => {
    const body = source.slice(start.index, starts[i + 1]?.index ?? source.length);
    const guarded =
      body.includes("requireStepUp(") ||
      helpers.some((name) => body.includes(`${name}(`)) ||
      rows.some((row) => body.includes(`"${row}"`));
    if (guarded) found.push(`${relative(dashboard, path)} ${start[1]}`);
  });
}
found.sort();
console.log(found.join("\n"));

if (process.argv.includes("--check")) {
  const recipe = readFileSync(join(here, "../features/step-up.md"), "utf8");
  const listed = [...recipe.matchAll(/^\| `(src\/[^`]+)` \| `(\w+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
  const missing = found.filter((f) => !listed.includes(f));
  const extra = listed.filter((f) => !found.includes(f));
  for (const f of missing) console.error(`missing from features/step-up.md: ${f}`);
  for (const f of extra) console.error(`in features/step-up.md but not protected in the source: ${f}`);
  if (missing.length || extra.length) process.exit(1);
  console.error(`step-up.md covers all ${found.length} protected server functions`);
}
