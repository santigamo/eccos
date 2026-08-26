# Eccos — Operator Console Design (app.eccos.chat)

How the Eccos brand behaves as the **operator console** (`apps/dashboard`), established
in the August 2026 alignment pass. The premise in one line: **the console is the
machine room of the same building as eccos.chat** — same atmosphere, same typographic
hierarchy, same accent discipline; denser, quieter, built for operators.

Brand identity lives in [BRAND.md](./BRAND.md); the landing's system in
[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md). This document records what carries over,
what translates, and the console-specific rules — so future changes extend the line
instead of drifting back to "default shadcn dark".
`apps/dashboard/src/app.css` is the canonical source of the console's token values.

---

## What the console inherits (non-negotiable)

The landing's **two laws** apply verbatim:

1. **Nothing rounds a corner.** Every `--radius-*` token is 0 and the vendored
   shadcn/reui components carry an explicit `rounded-none` pass. A new component
   shipping with a radius is off-system.
2. **Two voices.** Uppercase micro-labels at 10–13px are **Geist Pixel**
   (`font-pixel`, tracking 0.04em) in `--muted`-or-stronger ink: page kickers,
   table headers, form labels, tags, stat numbers, the version stamp. Prose,
   headings, nav items and buttons are **Inter**. No third voice, no third font.

Both faces are self-hosted in `apps/dashboard/public/assets/fonts/` with their OFL
licenses, preloaded in `__root.tsx`. Never load a font from a third-party host.

**Dark-only.** The console ships `<html class="dark">` with a single palette. Dark is
the brand's canonical rendering and an operator console does not need the landing's
daylight reading. If that ever changes, follow DESIGN-SYSTEM.md's light-theme
architecture — don't invent a second one.

## Token contract

`app.css` defines the landing's interaction tokens with values copied from
`apps/site/public/styles.css` (that file stays canonical — if the landing changes,
re-copy; the two must not drift independently):

`--line` (structural hairlines, = `--border`) · `--line-strong` (interactive edges)
· `--ghost-fill` / `--ghost-fill-hover` / `--ghost-edge-hover` (the green hover edge)
· `--hatch-line` · `--nav-bg` (masthead wash) · `--caustic` / `--caustic-hi` (primary
CTA glow shadow) · `--tag-live-*` / `--tag-soon-bg` (status tag anatomy) · `--ease`
· `--color-glow` (#34e27a, in `@theme`, so `bg-glow` exists as a utility).

Any new theme-varying value must be a token here — a hardcoded color in a component
rule is off-system. The semantic inks are fixed: **warning `#f0a020`**, **destructive
surface `#e03131`**, **destructive text on dark `#ff7777`** (never `#e03131` as text —
~3.9:1). Vivid green never dims on hover; it **brightens** to `--color-glow`.

## Page anatomy

Every route renders the same skeleton (the `Page` component in `src/ui.tsx`):

1. **Header band** — pixel kicker (`GATEWAY` / `LOGS` / `CLOUD API` /
   `CONFIGURATION`) over a big light Inter heading (`1.75rem`, weight 400,
   tracking −0.012em, `opsz` 32), actions right-aligned.
2. **Hatch band** — the 24px 45° `.hatch-band` divider, on every page. It is the
   landing's chapter divider; here it opens every chapter the same way.
3. **Content** — sections directly on bare `--bg`. Real panels (forms, the
   Connection card, error details) are bordered `Frame variant="default"` panels
   sized to content (`FramePanel fit` — never `h-full` chains). The page root fills
   the viewport (`flex min-h-full flex-col`) so structure reaches the bottom and
   the void reads as intentional.

**Atmosphere**: a fixed, non-interactive emerald glow (`body::before`, two radial
gradients at ≤7% alpha) keeps the dark from reading dead — the console's translation
of the landing's silk. The masthead is the landing's: `--nav-bg` wash under a 14px
backdrop blur, 1px bottom rule.

## Interaction contrast (the console's own law)

The landing signals interactivity with green edges; the console keeps that signature
everywhere. Rest → hover → active must each be visibly distinct:

- **Sidebar**: rest ink is muted (72%); hover gets a white-7% fill and full-white
  ink; the active item gets the green tint `rgba(37,211,102,.10)`, a 2px inset green
  rail, full ink, green icon. Active + hover deepens the tint (`.16`) — active never
  falls back to the grey hover.
- **Buttons**: primary is solid `--green` on `#06120c`, hover **brightens** to
  `bg-glow` and carries `--caustic`. Ghost/outline (and select triggers) sit on
  `--ghost-fill` with a `--line-strong` edge; hover raises the fill and turns the
  edge green (`--ghost-edge-hover`). One primary per view; everything else is ghost.
- **Table rows**: `hover:bg-white/[.03]` — visible, quiet. No information exists
  only on hover.
- **Focus**: the green ring, everywhere. Never removed, never recolored.

## Data rules (how this console shows numbers)

Adopted August 2026 (informed by Vercel's report guidelines, translated to the
Eccos system — the practices, not the brand):

1. **Color only for meaningful state.** A healthy system is quiet: the status tag
   next to the heading suffices, and the health banner renders **only** when
   something is wrong (amber for degraded, red for unhealthy/unreachable). When an
   operator sees a banner, it always means something.
2. **Every metric links to its evidence.** Status is the index; the logs are the
   body. Counts navigate to the filtered log view that explains them
   (`failed 1` → `/deliveries?status=failed`). A number an operator cannot chase
   is a dead end.
3. **Facts strip, not metric boxes.** Aggregate stats render as rail-separated
   cells on the shared grid (`border-y` + 1px dividers, big pixel numbers, muted
   captions, machine-voice per-status links) — never as floating bordered boxes.
   State-meaningful counts take their semantic ink (`failed` red, `pending` amber);
   everything else stays muted.
4. **Header alignment = cell alignment.** Numeric columns right-align header and
   cells together; timestamps stay left-aligned. Tables keep 1px row rules, pixel
   headers in `--muted`, and scroll inside their own container — the page body
   never scrolls horizontally.
5. **Actions only where they mean something.** Row actions render only on rows
   where they apply (Retry on `failed`); other rows hold the rhythm with a muted
   em-dash. No dead buttons.
6. **Empty states have structure.** A pixel label (`NO DELIVERIES YET`), one
   normal-size muted sentence saying what will appear, and an action link only when
   a real action exists (clear filters, configure a target). Never a lone tiny
   muted sentence.
7. **Charts (when they arrive)**: zero baseline for length encodings, direct labels
   over legends, color only to distinguish series, drawn from the `--chart-*`
   tokens. Default to stillness — motion only for state change.

## Component base

The console is **shadcn + reui.io blocks**, kept structurally intact and restyled
through tokens and classNames — never rewritten, never themed with a second system.
When vendoring a new shadcn/reui component: run the square pass (`rounded-none`),
wire hover/focus to the interaction tokens above, put any uppercase micro-label in
the machine voice, and check its inks against the contrast floors (muted ≥4.5:1 on
its real background; machine voice uses `--muted`, never `--faint`).

## Before shipping a console change

- Diff against the two laws, then the interaction-contrast rules, then the data
  rules. If a screen looks "cleaner" but lost a green edge, a hover state, or an
  evidence link, it regressed.
- New values go through tokens; new imagery follows BRAND.md's glass recipes.
- `bun run typecheck` + `bun run test` from `apps/dashboard`; verify visually
  against the landing — the parity test is a side-by-side with eccos.chat:
  **same building, different room.**
