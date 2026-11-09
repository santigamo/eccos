import { describe, expect, test } from "bun:test";

/**
 * The light theme's token contract (docs/DESIGN-SYSTEM.md → "The light theme"):
 * the dark `:root` carries every theme token, and the two light blocks redefine
 * the same set. Reads SOURCE, because the cascade between the blocks is the
 * thing under test.
 */

const css = (await Bun.file(new URL("../src/app.css", import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations inside the block whose selector matches `header`. */
function body(header: RegExp): string {
  const match = header.exec(css);
  if (!match) throw new Error(`${header} is not in app.css`);
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`${header} is never closed`);
}

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().replace(/\s+/g, " ")]),
  );
}

const dark = tokens(body(/:root\s*\{/));
const lightSystem = tokens(
  body(/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{/),
);
const lightOverride = tokens(body(/:root\[data-theme="light"\]\s*\{/));

describe("light theme tokens", () => {
  test("both light blocks declare the same tokens with the same values", () => {
    expect(lightSystem).toEqual(lightOverride);
  });

  test("the light blocks carry the tokens the light theme adds", () => {
    const added = [
      "ink",
      "row-hover",
      "selection-bg",
      "lantern-display",
      "ambient",
      "auth-scrim",
      "silk-photo-display",
      "silk-canvas-display",
    ];
    for (const name of added) expect(lightSystem).toHaveProperty([name]);
  });

  test("every light token also exists in :root", () => {
    expect(Object.keys(lightSystem).filter((name) => !(name in dark))).toEqual([]);
  });
});
