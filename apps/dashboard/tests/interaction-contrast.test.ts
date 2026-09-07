import { describe, expect, test } from "bun:test";

/**
 * The console's interaction-contrast law and its two colour tokens, asserted
 * (docs/DASHBOARD-DESIGN.md → "Interaction contrast" and "Token contract").
 *
 * Everything here reads SOURCE rather than rendering. Both defects it covers
 * live in states a static render cannot reach — a hovered row, an open menu in
 * a portal — and both shipped to production precisely because no test could
 * see them. A class string and a token value are what is reachable, so that is
 * what gets pinned.
 */

const appCss = await Bun.file(new URL("../src/app.css", import.meta.url)).text();

/** The value of a `--token:` declaration in the theme block. */
function token(name: string): string {
  const match = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m").exec(appCss);
  if (!match) throw new Error(`--${name} is not declared in app.css`);
  return match[1].trim();
}

describe("--accent is a lift, not a surface", () => {
  test("it never equals a surface it is painted over", () => {
    // THE DEFECT. `--accent` was `#0f1d1e` — the same value as `--popover`,
    // `--muted` and `--secondary` — so every `hover:bg-accent` in the console
    // painted a row in exactly its own background. A dropdown row, a select
    // option and a data-grid filter row all had no hover at all, no matter
    // which selector they used, and the fix for the SELECTOR alone would have
    // changed nothing on screen.
    const accent = token("accent");
    for (const surface of ["popover", "muted", "secondary", "card", "background"]) {
      expect(accent).not.toBe(token(surface));
    }
  });

  test("it is a translucent lift, so it works on any of those grounds", () => {
    // A hex would have to be chosen per surface; the sidebar's own row hover is
    // the same idea at 7%, and `--ghost-fill` takes the same 8% step.
    expect(token("accent")).toMatch(/^rgba\(255,\s*255,\s*255,/);
  });
});

describe("destructive ink", () => {
  test("no component paints text with the surface token", async () => {
    // `--destructive` (#e03131) is a SURFACE colour: as text on this console's
    // ground it is ~3.9:1, under the 4.5:1 floor, and the contract fixes
    // destructive TEXT as `--destructive-foreground` (#ff7777). This swept nine
    // sites, every one of them ERROR copy — the worst place to sit under the
    // floor — plus the menu item that put #e03131 on app.eccos.chat.
    //
    // `bg-destructive/10` and `border-destructive/20` are deliberately NOT
    // matched: a wash and an edge are surfaces, and they keep the surface token.
    const offenders: string[] = [];
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({
      cwd: new URL("../src", import.meta.url).pathname,
      absolute: true,
    })) {
      const source = await Bun.file(file).text();
      if (/text-destructive(?!-foreground)/.test(source)) {
        offenders.push(file.slice(file.indexOf("/src/") + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});

const menu = await Bun.file(
  new URL("../src/components/ui/dropdown-menu.tsx", import.meta.url),
).text();

describe("dropdown menu rows", () => {
  test("the active row answers data-highlighted, which is what Base UI sets", () => {
    // Upstream paints the state on `focus:`, a React/Radix habit. Base UI does
    // not move DOM focus onto the hovered row — it marks it with
    // `data-highlighted` (menu/item/MenuItemDataAttributes.js) — so the pointer
    // crossed "Send test" and nothing moved.
    expect(menu).toContain("data-highlighted:bg-accent");
    expect(menu).toContain("data-highlighted:text-accent-foreground");
    // The destructive row keeps its own wash on the same state.
    expect(menu).toContain("data-[variant=destructive]:data-highlighted:bg-destructive/10");
  });

  test("a menu row says it is a control", () => {
    expect(menu).not.toContain("cursor-default");
    expect(menu).toContain("cursor-pointer");
  });

  test("the destructive row's ink is the foreground token", () => {
    // Fixed in the COMPONENT, not at the call site: a variant-prefixed utility
    // beats an unprefixed override on specificity, and tailwind-merge does not
    // treat the two as the same key — so `className="text-destructive-foreground"`
    // on the item loses silently. That is how #e03131 reached production.
    expect(menu).toContain("data-[variant=destructive]:text-destructive-foreground");
    expect(menu).toContain("data-[variant=destructive]:data-highlighted:bg-destructive/10");
  });
});
