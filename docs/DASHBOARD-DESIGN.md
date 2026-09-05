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
2. **Two voices, console distribution.** No third font — but the console
   deviates from the site in *which* voice carries functional micro-labels,
   because an operator reads them hundreds of times a day and a pixel face is
   unforgiving on non-retina displays:
   - **Geist Pixel = brand accents only** (low frequency, high meaning): the
     page kickers (`GATEWAY` / `LOGS`…), the facts-strip cell kickers and big
     stat numbers, the masthead's `OPERATOR CONSOLE`, the version stamp, and
     the address read back on the check-your-inbox screens (`AddressReadback`
     in `src/components/auth/auth-page.tsx`) — the same *datum* category as the
     stat numbers: one value, read once, that has to be read exactly, on a
     screen an operator sees twice in their life. Its label stays Inter.
     12px floor (11px for the version stamp), grayscale antialiasing
     (`.font-pixel` in `app.css`) — never smaller: a pixel face off its grid
     blurs.
   - **Inter uppercase = the functional register** (11px, `font-medium`,
     `tracking-wider`, `--muted`-or-stronger ink): table headers, form labels,
     panel titles, status tags, per-status count links, empty-state labels.
   Adding a pixel label to high-frequency data UI — or a third face anywhere —
   is off-system.

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
· `--hatch-line` · `--caustic` / `--caustic-hi` (primary CTA glow shadow)
· `--tag-live-*` / `--tag-soon-bg` (status tag anatomy) · `--ease`
· `--color-glow` (#34e27a, in `@theme`, so `bg-glow` exists as a utility).
`--nav-bg` started as a copy but is a **documented console deviation** — it joined
the glass family (see "Atmosphere, glass, and the lantern").

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

## Overlays (which surface, and which register)

Anything that covers a page is one of three registers, and the register is chosen by
what the operator is being asked to do — never by how much markup happens to fit.

`Sheet` and `Dialog` are the **same primitive**: both wrap `@base-ui/react/dialog`
(`src/components/ui/sheet.tsx:4`), and a sheet is that dialog docked to a side. "Which
component" is therefore never the question. The register is.

1. **AlertDialog — confirm a one-click destructive act requested elsewhere.** The
   operator already pressed Delete on a row; this surface only asks whether they meant
   it, and states the cost in the system's own terms (`delete-template-dialog.tsx`:
   deleting an APPROVED template locks its name for 30 days, a draft locks nothing).
   No fields. Two buttons, the destructive one carrying the verb.
2. **Centred Dialog — a decision the operator must read before leaving the page.** No
   fields, no submit: the choices themselves are the actions, because the fork is
   structural and cannot be revisited afterwards. Shipped: the add-number fork on
   `/numbers` — Meta fixes `featureType` the instant its popup spawns, so the console
   has to ask first or not at all. The consequence copy is the whole payload, so the
   surface is sized around it: the fork's amber line wraps to two lines at the house
   sheet width (`sm:max-w-md` gives its column 328px; the line measures 363px), which
   is why `Dialog` defaults to `sm:max-w-lg`. Measure before narrowing one.
3. **Side Sheet — a task done beside the list, or one row inspected without acting on
   it.** Task: a form with its own primary submit whose neighbouring list is genuinely
   relevant (`create-template-sheet.tsx`, `send-test-sheet.tsx`). Inspection:
   `template-preview-sheet.tsx`, read-only by construction.

**The two edges that get mis-cut.**

- **An irreversible side effect does not by itself pull a surface into the confirm
  register.** `send-test-sheet.tsx` sends a real WhatsApp message to a real phone and
  stays a Sheet, because its act is *composed* — pick the sender, type the recipient,
  fill every `{{n}}`, read the preview — and the composition **is** the confirmation.
  AlertDialog gates a one-click act; it does not gate a form. Stacking a confirm on
  work the operator just built by hand only teaches them to dismiss confirms.
- **Read-only inspection is its own register, and it lives in a Sheet.** A modal exists
  to collect a decision; a look-up has no decision behind it, so a modal for one is
  pure interruption. Inspection docks beside the row it came from and leaves the list
  legible.

**Dismissal — the corollary, and the defect this section was written from.** All three
registers refuse backdrop and Escape dismissal while an irreversible operation is in
flight or while unsaved input exists, and all three always offer an explicit close (the
`SheetClose` X, a Cancel, a named way out of a fork). Base UI hands the confirm register
half of that for free: alert-dialog mode forces `modal: true` and
`disablePointerDismissal: true` (`@base-ui/react/dialog/root/useRenderDialogRoot.js:32`)
but deliberately leaves Escape alone — which is right, because on a confirm **Escape
means Cancel**. Deliberate abandonment always stays possible. A surface an operator
cannot leave is not careful, it is broken: a decision shipped as a non-dismissible
inline panel with no close is exactly the bug that produced this rule.

## Atmosphere, glass, and the lantern

The console's dark is lit, not dead — three layers, all under the content:

- **Ambient glow** (`body::before`): three fixed radials — emerald top-right
  (10%), a faint mid-page veil (3.5%), teal bottom-right (7%) — so the light
  travels the page diagonally instead of pooling in one corner. The content
  column must stay transparent for it to work: `SidebarInset` gets
  `bg-transparent` (its default `bg-background` is opaque and blocks the floor).
- **Glass surfaces**: the big surfaces are translucent — `--card` and
  `--sidebar` are `rgba(13, 26, 27, 0.55)`. The tint is **teal-shifted off
  BRAND.md's charcoal**: `#0b141a` is blue-dominant (B=26 > G=20) and under
  emerald light simultaneous contrast makes it read navy; the resting composite
  still lands in the charcoal family. The raised family (`--popover`,
  `--secondary`, `--muted`, `--accent`) is `#0f1d1e` for the same reason.
  **Floating surfaces stay solid** (popovers, dropdowns, selects sit over text),
  and the sticky table header row is solid `bg-muted` so scrolled rows never
  bleed through it.
- **The lantern** (`#cursor-light` + the `CursorLight` component in
  `__root.tsx`): a faint green light (6%, 1200px) that *trails* the pointer with
  a lerp — the console's one spectacle, as the silk shader is the landing's.
  It paints under the lifted content, so it lights the floor between panels,
  never the text. Gone on coarse pointers and under `prefers-reduced-motion`;
  the rAF loop parks itself when the pointer rests. Everything else stays quiet
  — do not add a second ambient motion.

The masthead keeps the landing's construction (`--nav-bg` wash under a 14px
backdrop blur, 1px bottom rule) but its wash joined the glass family —
`rgba(13, 26, 27, 0.55)`, a deliberate console deviation from the site's
`rgba(7, 12, 15, 0.72)` so the atmosphere reads through the bar too.

### The one-spectacle rule, per surface (pre-auth deviation)

The lantern is the console's one spectacle — but the rule is **per surface**, and
the pre-auth brand panel (sign-in / sign-up, the reui auth-13 split screen) is a
different surface: there the landing's iridescent silk owns the spectacle and the
lantern is absent (gated by `LANTERN_EXEMPT_PATHS` in `__root.tsx`). The silk
renders under the brand panel's glass through `SilkPanel`
(`src/components/blocks/auth-13/components/silk-panel.tsx`) — a byte-identical
port of the site shader (`apps/site/public/js/shader.js`, keep the FRAG/VERT
in sync; the console pins `u_light = 0`, dark-only) with a CSS gradient fallback
(no WebGL, reduced motion, context loss). Below the `lg` breakpoint the brand
panel does not render and the form is the whole page; the WebGL context is not
even allocated there. The hatch band stays out of the panel: over the silk it
read as noise, not as the chapter divider it is on flat pages.

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
7. **A failure names only what it knows.** Server functions return a typed
   failure class (`unreachable` / `unauthenticated` / `forbidden`, decided from
   the thrown error's type in `src/server/gateway.ts`), and `FailureView`
   renders one screen per class — never one card for all of them. Only
   `unreachable` may say the gateway is unreachable. An authorization refusal
   is a step the operator has not taken, not an outage: it renders like the
   pending note on /numbers — a title, one sentence, and the action that
   resolves it (create a workspace, choose one, sign in) — with no red banner
   and no raw server message. Adding a new refusal means adding its reason code
   in `auth/tenant.ts` and its copy in `lib/failure.ts`, never string-matching
   a message in a component.
8. **Charts (when they arrive)**: zero baseline for length encodings, direct labels
   over legends, color only to distinguish series, drawn from the `--chart-*`
   tokens. Default to stillness — motion only for state change.

## Component base

The console is **shadcn + reui.io blocks**, kept structurally intact and restyled
through tokens and classNames — never rewritten, never themed with a second system.
When vendoring a new shadcn/reui component: run the square pass (`rounded-none`),
wire hover/focus to the interaction tokens above, put any uppercase micro-label in
the machine voice, and check its inks against the contrast floors (muted ≥4.5:1 on
its real background; machine voice uses `--muted`, never `--faint`).

**The overlay set is closed.** `Sheet`, `Dialog` and `AlertDialog` cover the three
registers above; vendoring a fourth overlay means first naming a register those three
cannot express. Whatever it is, its surface stays solid `--popover` — floating things
sit over text.

## Before shipping a console change

- Diff against the two laws, then the interaction-contrast rules, then the overlay
  registers, then the data rules. If a screen looks "cleaner" but lost a green edge,
  a hover state, or an evidence link, it regressed.
- A surface that covers the page names its register out loud — confirm, decision,
  task, or inspection — and proves it can be left: an explicit close, plus Escape
  whenever nothing irreversible is in flight and nothing is unsaved.
- New values go through tokens; new imagery follows BRAND.md's glass recipes.
- `bun run typecheck` + `bun run test` from `apps/dashboard`; verify visually
  against the landing — the parity test is a side-by-side with eccos.chat:
  **same building, different room.**
