import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// AGENTS.md pairs each rule with the check that enforces it. A row that names a
// file which is not there enforces nothing, so every path in the table must exist.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const agents = readFileSync(`${root}AGENTS.md`, "utf8");

const section = agents.split(/^## /m).find((s) => s.startsWith("Rules and what enforces them"));
if (!section) throw new Error('AGENTS.md has no "Rules and what enforces them" section');

const paths = [...section.matchAll(/`([^`\s]+)`/g)]
  .map((m) => String(m[1]))
  .filter((token) => token.includes("/") && !token.includes("*"));

describe("AGENTS.md rules table", () => {
  it("names files", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  for (const path of new Set(paths)) {
    it(`${path} exists`, () => {
      expect(existsSync(`${root}${path}`), `AGENTS.md names ${path}; use the path from the repository root`).toBe(true);
    });
  }
});
