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
rule is off-system. **`--accent` is the hover LIFT and must never equal a surface**
(`--popover`, `--muted`, `--secondary`, `--card`, `--background`): it was `#0f1d1e`,
the same value as three of them, so every `hover:bg-accent` in the console painted a
row in its own background and no dropdown row, select option or filter row had a hover
at all. It is a translucent white lift for that reason — one value that works over any
of those grounds. The semantic inks are fixed: **warning `#f0a020`**, **destructive
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
   `template-preview-sheet.tsx`, read-only by construction, and the two log sheets
   (`components/logs/message-sheet.tsx`, `event-sheet.tsx`) — one message or one event,
   hop by hop, with the full Meta ids, what the thing actually said, and the provider
   payload behind a disclosure (data rule 10).
   Inspection sheets are **URL-addressable** (`/messages?message=1042`,
   `/events?event=77`): a forensic finding is worth nothing if it cannot be pasted to a
   colleague, and the address is not a loader dep, so opening one never re-paints the
   list underneath it. An addressed row that is not on the current page says so and
   offers the page that holds it — it never silently opens nothing.
   The event sheet carries **exactly one act**, Retry on a failed batch, and that does not
   move it out of the inspection register: it is the same act its row already offers,
   placed where the operator has just read the evidence for it. Sending them back out to
   the row to press it would be the interruption the register exists to avoid. One act
   the reader arrived wanting is not a second register; a form is.

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

## Waiting (what the console owes an operator mid-navigation)

Every log route crosses an RPC service binding to the gateway on entry, and TanStack
keeps the **previous match mounted** until the next one resolves. Meanwhile
`useLocation()` reads `state.location`, which the router points at the destination the
instant a link is pressed — so the sidebar repaints its active item immediately and the
page under it does not. Left alone, that combination is the worst reading in the
product: the navigation claims to have happened and the content says otherwise, and a
fast gateway still feels like a dead click.

Two layers answer it, and the seam between them is a duration:

1. **The rail** (`route-progress.tsx`, `.route-progress` in `app.css`) — a 2px sweep
   across the top edge, above the masthead, driven by `router.state.isLoading`. It
   lights on **every** navigation with no delay and costs no layout, which is what makes
   it the answer to the click itself. It is **indeterminate on purpose**: the router
   knows a load is in flight and never how far along it is, and a creeping percentage
   would be the one invented number in a console whose data rules are about exact
   readings. It also announces through a live region, because a route change swaps the
   main region with no focus move.
2. **The route's own skeleton** (`pendingComponent`, via `GridPending`) — the
   destination's real title, kicker and column headers over skeleton rows. This is the
   answer to the **wait**, not the click: past `defaultPendingMs` (350ms) the previous
   page's rows have stopped being context and become a lie, so they are replaced by the
   structure of the page that was asked for.

The rules that follow from it:

- **Never a bare spinner over a page.** What is already known at navigation time — the
  title, the kicker, the column headers — is rendered; only what is genuinely pending
  is drawn as a skeleton. A page that knows its own name says it.
- **Never a fake percentage, and never a relative estimate.** Indeterminate work reads
  as indeterminate, the same honesty the failure rule (data rule 7) asks for.
- **A skeleton row is never an empty row.** The vendored data grid takes its skeleton
  cell from `meta.skeleton`; `LogGrid` fills a default in so a loading grid never paints
  structure with nothing in it, which reads as broken rather than as loading.
- **No `defaultPendingComponent`.** The timeout that promotes a match to its pending
  view is only armed for routes that have one, so a default arms it for the **root**
  match — whose component is the entire chrome. A slow root load would blank the shell
  instead of filling the page inside it. Pending views are declared per route.
- **Motion only for state change** still holds: the sweep exists because something is
  happening, and under `prefers-reduced-motion` it stops travelling and holds a steady
  dim green rail. The answer survives; the movement does not.

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
  only on hover. A row that **opens something** (the template name on /templates, the
  MESSAGE cell on /messages, the KIND cell on /events) owes
  the reader a real control inside it — focusable, labelled, and marked at rest with the
  door anatomy `COUNT_LINK` gives a count that navigates. A row may hold **two** doors to
  two different destinations (an event's KIND opens its own sheet; its PARTY opens the
  message the event is about) — what is not allowed is a destination with no door. The row click is a wide target
  over that control, never the only way in: the grid hangs `onRowClick` off a bare
  `<tr>` with no role and no tab stop, so a row-only affordance is unreachable by
  keyboard and invisible until a pointer guesses. Anything else in the row that takes a
  click (a kebab, an inline button) stops its own event — and covers only ITSELF. A
  shield stretched across a wide cell (`flex justify-end` in a column holding the
  table's slack) swallows every row click that lands in the empty part of it, and the
  row reads as dead over half the table.
- **Menus and select popups**: the active row is `data-highlighted`, which is what
  Base UI sets — **not** `:focus`, which upstream shadcn styles because Radix moves DOM
  focus and Base UI does not. A menu row is a control: it takes `cursor-pointer`, not
  the vendored `cursor-default`.
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
   never scrolls horizontally. A table with FEW short columns sizes them in
   percentages: `table-auto` hands the leftover to whichever column asks, which on
   /templates left the page reading as a strip down the left quarter. The action
   column stays unsized so the leftover lands there and the kebab keeps the right edge.
5. **Actions only where they mean something.** Row actions render only on rows
   where they apply (Retry on `failed`); other rows hold the rhythm with a muted
   em-dash. No dead buttons — and a row with nothing to offer shows the em-dash, not an
   empty menu. Where a row carries more than one **writing** act, they collapse into one
   right-aligned kebab under a screen-reader-only header: the deliberate second click is
   right for acts that leave the console (a real WhatsApp send, a delete at Meta), and
   it stops the row's identity from competing with a rank of buttons. Read-only acts
   stay out of that menu and live on the row itself.
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
9. **One word, one hop.** A relay has three hops and they share vocabulary, so the
   console names each hop in words that cannot be confused with the others:

   | hop | words | where |
   |---|---|---|
   | Eccos → Meta | `sent` · `failed` | /messages, META column |
   | Meta → the phone | `delivered` · `read` · `failed` | /events KIND, /messages TRAIL |
   | Eccos → subscriber | `forwarded` · `held` · `queued` · `retrying n/6` · `failed` | /events FORWARD, the queue |

   The database keeps its own words (`deliveries.status` is `pending`/`delivered`/
   `failed`, and that is the forwarding contract — it does not move). The console
   translates at the edge, in `lib/forwarding.ts`, tested without a DOM. **`delivered`
   never means a forward again**: it meant both "your subscriber got the batch" and "the
   customer's phone got the message" on one screen, and no colour or column heading
   fixes a word that is already taken.

   Three of those words are the same row state read three ways, and the reading needs a
   fact the row does not carry: `pending` is `held` with no forwarding target, `queued`
   with one and no attempt spent, `retrying n/6` with one and attempts spent. A state an
   operator cannot act on (`queued`) stays neutral; the two that ask for something take
   amber. And a column that shows a timestamp **names which moment it is** — `finished` /
   `next` / `held` — because "Next attempt" over a held row's arrival time is a lie by
   label, not a rounding error.

10. **Raw provider output is never a surface's primary content — and it is never
    deleted either.** The masthead says OPERATOR CONSOLE: the default reader is an
    operator, not an integrator, and a section that opens onto pretty-printed Meta JSON
    asks them to be one. So a surface holding a stored payload leads with what it can
    READ out of it and keeps the payload one `<details>` disclosure down
    (`RawDisclosure` in `components/logs/sheet-parts.tsx`), under a summary that states
    the claim the payload backs — "exactly what your receiver got". Both halves are
    load-bearing: when Meta answers `132000`, that body is the only thing that explains
    why, so deleting it would push debugging out of the product into Cloudflare logs and
    leave the operator with nothing to hand their developer. A disclosure is **not** an
    overlay — it reveals in place rather than covering the page — so the closed overlay
    set below is untouched by it, and `<summary>` is focusable and Enter-activated by
    the browser, which is a stronger guarantee than any handler we would write.

    **The readable half is built only from what is STORED.** `outbound_messages.request`
    carries a template's name, its language and its parameter VALUES, and not one word
    of its copy — the copy only ever lived at Meta. So the message sheet renders
    `{{1}} Ada`, labelled by slot, and *links* to the template while saying the link is
    today's copy. Joining to the template as it stands now to draw a preview is
    forbidden: a thirty-day-old message whose template has since been edited would
    render words it never carried, with the authority of a preview, and on a forensic
    surface that is the worst failure mode there is, because it does not look like one.
    The readers are pure and live in `lib/` (`requestReading`, `eventReading`), so every
    branch is asserted without a DOM — the same discipline as `lib/forwarding.ts`.

    **Each silence is its own sentence.** A body swept by content retention, a body that
    will not parse, a template send that filled no parameters, a delivery receipt that
    carries no content by construction, and a message kind the console has no reading
    for are five different facts. One shared "nothing to show" would tell an operator
    that their `hello_world` send was somehow damaged.

    The rule reaches past the log sheets. An error card whose body is
    `JSON.stringify(providerError)` is the same defect, and it is only tolerable while
    the console has no reading of that payload at all — `/templates`' load-failure card
    is the outstanding case (eccos-1ri). Where the console *can* read a payload, the
    disclosure is where the payload lives.

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
sit over text. The `<details>` disclosure of data rule 10 does **not** count against
that set and no accordion component is needed for one: it reveals in place instead of
covering the page, and the browser already gives its `<summary>` a tab stop and Enter
activation. It is styled like every other ghost control — square, `--line-strong` edge
on `--ghost-fill`, green edge and lift on hover, the green focus ring.

## Before shipping a console change

- Diff against the two laws, then the interaction-contrast rules, then the overlay
  registers, then the data rules. If a screen looks "cleaner" but lost a green edge,
  a hover state, or an evidence link, it regressed.
- A surface that covers the page names its register out loud — confirm, decision,
  task, or inspection — and proves it can be left: an explicit close, plus Escape
  whenever nothing irreversible is in flight and nothing is unsaved.
- Anything that waits answers the click before it answers the wait: the rail lights
  immediately, the route's own skeleton takes over past `defaultPendingMs`, and neither
  invents a number. A new route with a loader ships with a `pendingComponent`.
- New values go through tokens; new imagery follows BRAND.md's glass recipes.
- A surface showing something a provider stored says what it READS out of it first, and
  keeps the payload behind the disclosure (data rule 10). If the readable half would
  have to join to a live record to exist, it does not get built: a record is not a
  preview.
- A word on a new surface is checked against data rule 9's table before it is written.
  If it names a hop, it uses that hop's vocabulary; if it names a state, the state's
  derivation is a pure function in `lib/`, not a ternary in a cell.
- `bun run typecheck` + `bun run test` from `apps/dashboard`; verify visually
  against the landing — the parity test is a side-by-side with eccos.chat:
  **same building, different room.**
