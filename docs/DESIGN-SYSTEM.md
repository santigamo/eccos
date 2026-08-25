# Eccos — Web Design System (eccos.chat)

The design language of eccos.chat, established in the August 2026 redesign
(direction: 1:1 with the Arion visual system, re-anchored in the Eccos brand).
`apps/site/public/styles.css` is the canonical source of values; this document
records the **intent and the rules**, so future changes stay coherent.
Brand identity (logo, palette origins, asset generation recipes) lives in
[BRAND.md](./BRAND.md) — this doc is how that brand behaves *as a website*.

---

## The two laws

Everything else follows from these. Break neither.

1. **Nothing rounds a corner.** `border-radius: 0` everywhere — buttons, tags,
   cards, images, inputs, SVG diagram boxes (`rx` removed). Every shape reads
   as an extension of the 1px rail grid. If a new component ships with a
   radius, it is off-system.
2. **Micro-labels speak in the machine voice; prose speaks Inter.**
   Every uppercase label at 11–13px is set in **Geist Pixel** (Square). Body
   text, headings (minus the accent phrase), nav links and button labels are
   always Inter. There is no third voice.

## Canvas, column, rails

- Page background `--bg: #070c0f` (near-black with the brand's cool cast).
  Raised surfaces `--panel: #0b141a` (brand charcoal), `--raised: #101a20`.
- All content lives in a centred **1264px column** (`--col`) whose left/right
  edges are full-height **1px rails** (`--line: rgba(255,255,255,.07)`).
  `.shell`, `.band` and `.hatch` each carry the rails themselves so the lines
  run continuous from masthead to footer. Outside the rails: bare `--bg`.
- Horizontal structure comes from 1px `border-top` rules between bands, plus
  **diagonal hatch dividers**: 64px-tall `.hatch` bands with a 45° repeating
  stripe in `rgba(255,255,255,.045)`, bordered top and bottom. Hatch bands
  separate *chapters* of the page; plain 1px rules separate rows within one.
- Gutters `--gut: clamp(20px, 3.4vw, 40px)`; band padding
  `.wrap: clamp(52px, 6.6vw, 96px)`; prose measure `--measure: 68ch`.

## Typography

Self-hosted only (SIL OFL, license copies in `assets/fonts/`). Never load a
font from a third-party host — the privacy policy's short processing chain is
a product feature.

| Face | File | Role |
|---|---|---|
| **Inter Variable** (`"Inter Var"`) | `assets/fonts/InterVariable.woff2` | Everything prose: headings, body, nav, buttons. One file, weights 100–900 + optical size axis. |
| **Geist Pixel Square** (`"Geist Pixel"`) | `assets/fonts/GeistPixel-Square.woff2` | The machine voice (see below). Single weight 400. |
| Geist Pixel Grid | `assets/fonts/GeistPixel-Grid.woff2` | Kept as an alternative texture (LED-grid look). Not currently used. |

- **Headings are weight 400** — the big-and-light grotesk look. All h1–h3:
  `font-variation-settings: "opsz" 32`, letter-spacing −0.012em, line-height
  1.16, `text-wrap: balance`, color `--text`.
- Scale: hero h1 `clamp(2.25rem, 5.9vw, 3.875rem)`; statement/band h2
  `clamp(1.75rem, 4.4vw, 3rem)`; feature-row h3 `clamp(1.375rem, 2.6vw, 2rem)`;
  body 1rem/1.7; `.lede` muted and max ~56–58ch.
- **The pixel-phrase signature**: exactly **one** phrase per heading is wrapped
  in `<span class="px">…</span>` → Geist Pixel at `0.92em`, tracking 0,
  `white-space: nowrap`. One per heading, never two, never zero on the big
  statement bands. Choose the phrase that carries the meaning ("actually own",
  "run it", "handled").
- **Machine voice** (`--pixel`, uppercase, 0.75rem, tracking 0.04em): the facts
  strip cells, tags/badges, kicker labels (WHAT'S INCLUDED…), data-table
  column headers, footer column titles, SVG diagram labels (13px, sentence
  case — they are proper names), stat numbers (`.statnum`, tabular). Pixel
  faces have thin stems at small sizes: machine-voice text uses `--muted`
  (≈7:1 on `--bg`), never `--faint`.

## Color

| Token | Value | Use |
|---|---|---|
| `--green` | `#25D366` | Brand anchor: links, ticks, focus ring, tag-live |
| `--glow` | `#34E27A` | Bright end of the CTA/glass gradient |
| `--teal` | `#0FB39A` | Cool end of the gradient |
| `--cyan` | `#22D3EE` | Shader iridescence only — not a UI accent |
| `--text` | `#F2F6F4` | Headings, emphasized text |
| `--muted` | `rgba(236,244,240,.66)` | Body/secondary — ≥7:1 on `--bg` |
| `--faint` | `rgba(236,244,240,.52)` | Tertiary only, never on imagery, ≥4.5:1 |

Rules: the green family is for **actions and accents**, never body text.
Iridescence (cyan, warm glints) exists only inside the shader and generated
imagery. Any text over imagery needs a scrim that guarantees ≥4.5:1 against
the brightest frame (hero: left+bottom scrim; footer: the glass wash).

## Components

- **Buttons** (`.btn`): 40px tall, square, 0 radius, Inter 0.875rem, padding
  0 22px; hover lifts 1px. **Primary** = the brand sweep
  `linear-gradient(105deg, var(--glow), var(--teal))` on `#06120c` text
  (11.2:1 → 7.2:1 across the sweep) with green glow shadow
  `0 6px 26px rgba(37,211,102,.24)`; hover brightens to `#4bea8c → #14c7ab`.
  **Ghost** = `rgba(255,255,255,.08)` + `--line-strong` border; hover/focus
  border turns `rgba(37,211,102,.45)`. `.btn-sm` = 34px. Primary is for the
  one action we actually want per band; everything else is ghost.
- **Tags** (`.tag`): machine voice, square, `5px 10px`, line-height 1.1.
  `tag-live` green tint, `tag-soon` neutral. Availability wording on the mode
  tags ("Available now" / "Early access") is load-bearing legal copy.
- **Cards**: no floating cards — cells share rails/rules with the grid (trio
  cards are rail-separated columns; mode cards split the band at the centre
  rail). Trio cards: image on top (generated glass render, square corners,
  edges darkened into `--panel`), then an `own-title` h3 (weight 600,
  1.0625rem, `--text`) and a muted paragraph.
- **Data table** (`.dtable`): machine-voice column headers, 1px row rules,
  green ✓ marks, lives inside a labelled `tabindex="0"` scroll container —
  the page body never scrolls horizontally.
- **Stat cells**: `.statnum` in pixel face `clamp(2.25rem, 4.8vw, 3.5rem)`,
  count-up on first view; caption muted, ≤30ch.
- **Masthead**: sticky, blur backdrop over `rgba(7,12,15,.7)`, 1px bottom
  rule. Brand = `logomark.png` at 28px + ECCOS wordmark (Inter 600, tracked).
  Below 760px the nav is an absolute drawer behind a hamburger
  (`aria-expanded`, Esc closes, click-outside closes); the toggle group takes
  `margin-left: auto` **because the drawer's absolute nav removes the auto
  margins that centred it** — regression to watch when touching the header.
- **Footer**: one compact block — disclaimer + Product/Legal/Connect columns
  (machine-voice titles) + © row — over `hero-silk.jpg` as a faint glass
  background: image at `64% 57%` (its brightest region), `blur(3px)`, under a
  `--bg → rgba(7,12,15,.86–.885)` wash. Text over it measures ≥4.9:1. No
  dedicated texture band; the texture is atmosphere, not a section.

## Motion

Philosophy: one hero spectacle, everything else quiet. Every animation has a
reduced-motion and no-JS story.

- **Hero shader** (`js/shader.js`, vanilla WebGL1, no libs): "iridescent
  silk" — high-frequency diagonal bands phase-warped by drifting value-noise
  fbm (threads + moiré, never blobby plasma). Two virtual layers in one pass:
  `silk(p*2.60, t, freq 42, speed .060)` + `silk(p*4.30, t*1.35, freq 63,
  speed .085)` mixed 50% — Arion's two stacked canvases at half the cost.
  Palette keyed emerald→teal→cyan with a warm glint (`vec3(.78,.53,.35)`)
  only at the brightest folds; vignette to black at left/bottom for the copy.
  DPR cap 1.5 + total-pixel ceiling + adaptive 0.7 downscale; rAF pauses when
  the hero leaves the viewport or the tab hides. Fallback chain (reduced
  motion, no WebGL, context loss, no JS): no canvas — CSS shows
  `hero-silk.jpg` at .55 opacity under the same scrims.
- **Reveals**: `.reveal` rises 12px / fades in 0.7s `--ease`
  (`cubic-bezier(.22,.61,.36,1)`); hero children staggered 0 / .12s / .24s on
  load; the rest on first intersection (threshold .15, rootMargin −4%
  bottom). Hidden states are gated behind `.js` on `<html>` **and**
  `prefers-reduced-motion: no-preference` — without JS or with reduced motion
  everything is simply visible.
- **Count-up**: stats animate 0→target in 1.2s cubic ease-out on first view;
  markup carries the final values, JS only animates them.
- **Diagrams**: CSS-keyframe SVG schematics; play-state toggled by an
  IntersectionObserver and `visibilitychange`; static complete drawing under
  reduced motion.
- **Micro**: buttons lift 1px; cells/cards brighten border+bg on hover. No
  information exists only on hover.

## Accessibility bar (non-negotiable)

Skip link; landmarks (`header/nav/main/section/footer`); h1→h2→h3 order;
`:focus-visible` 2px green ring; hamburger keyboard-complete; muted text
≥4.5:1 on its real background (machine voice uses `--muted`); table scrolls in
its own container; decorative images `alt=""` + explicit `width/height` +
`loading="lazy"` below the fold; everything readable without JS.

## Assets

| Asset | Use |
|---|---|
| `assets/hero-silk.jpg` | Hero fallback, footer glass background, final-CTA glow. 2400px, emerald silk (generation recipe in BRAND.md) |
| `assets/own-account.jpg` / `own-infra.jpg` / `own-data.jpg` | Trio cards: glass key / glass stack / glass vault, 1200px |
| `assets/logomark.png` | Nav + footer brand mark (28px/24px display) |
| `assets/avatar.png` | Full 512px logomark: apple-touch-icon, social avatars |
| `assets/banner.jpg` | OG image (approved wordmark banner) — do not swap casually |
| `assets/favicon.svg` + `-16/-32.png` | Flat simplified layers |
| `assets/fonts/*` | The two faces + OFL license copies (keep the licenses) |

New imagery must be **generated in the brand glass style** (BRAND.md prompts;
last run: Higgsfield `nano_banana_2` @2K), never lifted from references.

## Site invariants (legal / operational)

These outrank aesthetics. Before shipping any site change, verify:

1. **Facts that must stay on the landing**: provider name + Manresa
   (Barcelona), Spain + `hello@imsanti.dev` with links to the aviso legal and
   /privacy (the **full** identity — NIF, street address, phone — lives on
   /privacy and the aviso legal and must never leave *those*); what the
   service does (receive/forward with retry; send messages, templates,
   media); Embedded Signup + "pay Meta directly"; both modes with exact
   wording ("Available now" / "Early access" / "Not yet generally
   available"); the data guarantees (never cross-referenced / sold to
   brokers / used for ads or training; "30 days by default, configurable
   7–90"; Cloudflare EU jurisdiction); links to /privacy, /terms,
   /data-deletion, aviso legal; the Meta non-affiliation disclaimer.
2. **Legal page bodies are published documents** — restyle the shell freely,
   never touch their text.
3. **Zero third-party requests** except the Umami snippet, verbatim, exactly
   once per page (all five pages).
4. **Routes are frozen** (`/privacy`, `/terms`, `/data-deletion` registered
   with Meta); `wrangler.jsonc` keeps `html_handling: "drop-trailing-slash"`.
   (Local `wrangler dev` 404s `/` — local quirk only; verify the home with
   `python3 -m http.server` from `public/`.)

## Extending the site

- **New section** = a `.band` (+ preceding `.hatch` if it starts a chapter),
  a heading with one `.px` phrase, `.reveal` on its content blocks, values
  from the tokens — no new colors, no new fonts, no radii.
- **New page** = copy the shell of an existing page: head (meta + favicon +
  font preload + `styles.css` + Umami), masthead, footer, skip link,
  `id="main"`. Then the content in `.doc` typography.
- When in doubt, diff your work against the two laws first, the invariants
  second, and Arion's rhythm (big quiet bands, 1px lines, one spectacle) last.
