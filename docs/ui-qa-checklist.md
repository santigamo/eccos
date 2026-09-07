# Operator console — manual UI QA checklist

`apps/dashboard` (the operator console) has automated coverage for its server/data layer
(`apps/dashboard/tests/gateway.test.ts`), a couple of render smoke tests for its shared UI
primitives (`apps/dashboard/tests/ui.test.tsx`), and the Cloudflare Access gate
(`apps/dashboard/tests/access.test.ts`) — but **nothing automated checks the rendered product UI**
(visual correctness, responsive layout, keyboard navigation, or accessibility). This checklist is
the manual gate for that until an automated visual-regression suite exists (see the note at the
bottom).

Run it:

- Before any release that touches `apps/dashboard/src/routes/*`, `src/ui.tsx`, or `src/routes/__root.tsx`.
- After any Cloudflare Access (`src/access.ts`) or dashboard `wrangler.jsonc` config change.
- Against `bunx vite dev` (gateway running) **and** with the gateway worker stopped, to exercise
  the "unreachable" fallback described in `apps/dashboard/README.md`.

Check in at least one Chromium-based browser and one WebKit/Firefox browser, plus one narrow
viewport (≈375px, e.g. device toolbar / phone-sized window — the console has no dedicated mobile
layout, so this is about confirming it degrades acceptably, not pixel-perfect mobile design).

## How to exercise each state

- **Reachable / happy path**: run the gateway (`cd apps/gateway && bunx wrangler dev`) and the
  dashboard (`cd apps/dashboard && bunx vite dev`) together, per the README.
- **Unreachable**: run only the dashboard, with the gateway stopped (or `GATEWAY` binding pointed
  at nothing) — every view should render its "Gateway unreachable" card, never a crash/500.
- **First run**: use a fresh control-plane namespace, open `/setup`, create a workspace, and confirm
  the generated account ID and API key appear only after the POST succeeds. Refreshing the page
  must not show the raw API key again, and an account with no WABA must remain visibly distinct from
  the ready console. With `GATEWAY_PUBLIC_URL` configured, **Connect WhatsApp** must start the
  account-bound Embedded Signup handoff without asking for an account API key.
- **Auth gate (Cloudflare Access)**: only testable against a deployment with `ACCESS_TEAM_DOMAIN`
  / `ACCESS_AUD` set (see README § "Securing with Cloudflare Access"). Localhost `vite dev` is
  allowed without the gate; public hosts fail closed.

## Cross-cutting — nav shell & shared states (`src/routes/__root.tsx`, `src/ui.tsx`)

- [ ] Visual: nav bar (brand + 6 links) renders correctly at the top of every page; sticky
      positioning keeps it visible on scroll without overlapping content.
- [ ] Visual: the active route's nav link is visibly distinguished (background/color) from the
      other five.
- [ ] Responsive: at ≈375px width the nav links wrap (`flexWrap: "wrap"`) instead of overflowing
      or getting clipped; the brand mark stays legible.
- [ ] Responsive: page content (`Page`/status cards/tables) reflows sensibly down to ≈375px —
      tables should scroll horizontally (`tableWrap` has `overflowX: auto`) rather than break the
      layout.
- [ ] Keyboard: `Tab` from the top of the document reaches all 6 nav links, in visual left-to-right
      order, before reaching page content.
- [ ] Keyboard/focus: every nav link, button, input, and select across the app shows a visible
      focus outline/ring when reached via keyboard (no `outline: none` with nothing substituted).
- [ ] Accessibility: nav links are real `<a>`-rendering `Link` components (not `<div onClick>`),
      reachable and activatable with `Enter`/`Space` via keyboard alone.
- [ ] Accessibility: page `<title>` (`Eccos — Operator Console`) and `lang="en"` are present (view
      source / devtools — set once in `__root.tsx`, shared by all routes).
- [ ] Accessibility: text/background color contrast is legible for body text (`#e6e9ef` /
      `#aeb6c2` on `#0b0e14`/`#11161f`), muted text (`#7a8290`), and status colors (green/amber/red)
      — spot-check with a contrast checker, especially the amber "degraded/pending" tone.
- [ ] Unreachable state: with the gateway stopped, every one of the 6 views (see below) renders
      the "Gateway unreachable" card with the RPC error message visible, instead of a blank page,
      infinite spinner, or thrown error.

## Status (`/`, `src/routes/index.tsx`)

- [ ] Visual: health badge (colored dot + label) matches the gateway's reported `health`
      (healthy/degraded/unhealthy) with the right color for each.
- [ ] Visual/copy: with **no forwarding target** and a held backlog, the amber banner names the
      wait ("N events are waiting for a forwarding target") and offers the "Set a forwarding
      target" link to `/webhooks` — never the generic "reduced capacity" sentence, which belongs
      to a gateway that has somewhere to send.
- [ ] Visual: Connection fields (WABA ID, phone number ID, display phone, connected-at) render, and
      missing values show `—` rather than blank/`null`/`undefined`.
- [ ] Visual: Events/Messages/Forwards count cards lay out in the responsive grid
      (`repeat(auto-fit, minmax(220px, 1fr))`) — 3 columns wide, wrapping to fewer as the window
      narrows.
- [ ] Unreachable: badge falls back to "unreachable" label in the unhealthy (red) color; the
      Connection/count cards are replaced by the unreachable card (not shown empty).
- [ ] Keyboard/focus: the page's only interactive controls are the facts-strip count links and,
      when it renders, the banner's forwarding-target link — each reachable by Tab with the green
      focus ring. Confirm nothing else is a false-interactive element (a fact cell that is not a
      link must not be announced as one).

## Forwarding queue (`/deliveries`, `src/routes/deliveries.tsx`)

Unlisted in the sidebar and reachable from every count link in the console.

- [ ] Visual: table columns (Batch, Enqueued, Events, State, Attempts, When, Last error, Action)
      align; State uses the FORWARD vocabulary (`forwarded` green, `held`/`retrying` amber,
      `queued` neutral, `failed` red) and never the words `pending` or `delivered`.
- [ ] Data: Attempts renders `2 / 6`, never a bare count — the ceiling is what makes it mean
      something, and `0 / 6` on a held row reads as "nothing spent".
- [ ] Data: the When column NAMES its moment — `finished <time>` on a terminal row, `next <time>`
      on one waiting with a target, and a bare `held` with **no time at all** when no target is
      configured. A held row showing a next attempt in the past is the exact bug this replaced.
- [ ] Data: the Events column says what the batch carries (`1 reply`, `2 delivered · 1 read`), and
      `content expired` on a row whose payload retention has swept.
- [ ] Visual/copy: with no target and a held backlog, the amber rail line above the grid reads
      "Forwarding is held — no target is set…" and links to `/webhooks`. With a target set, or
      with nothing waiting, it renders nothing at all (no rail, no margin).
- [ ] Visual: the state `<select>` filter lists `all states` plus the observed states under their
      translated labels (`waiting` / `forwarded` / `failed`); selecting one updates the URL search
      (`?status=pending`) — the VALUES stay the database's, because every count link uses them.
- [ ] Visual/empty state: filtering to a state with no rows shows "No batches match this view."
      (not a blank table); with no filter and no data, "NO BATCHES YET".
- [ ] Interaction: "Retry" appears ONLY on a failed row — never on a forwarded one, which
      `retryDelivery` would happily replay into the customer's system a second time. It disables
      itself and shows `…` while in flight, then the list refreshes (`router.invalidate()`).
- [ ] Pagination: "Load older →" is disabled when the current page is short (<50 rows); clicking it
      appends `before=<oldestId>` to the URL; "← Latest" appears only when paginated and clears it.
- [ ] Responsive: at ≈375px the table wrapper scrolls horizontally instead of squashing columns
      unreadably.
- [ ] Keyboard: the filter `<select>`, every row's "Retry" button, and both pager buttons are
      reachable via `Tab` and operable via keyboard.
- [ ] Accessibility: the filter control has an accessible name and the "Retry" buttons are
      `<button type="button">` so they're announced as buttons.
- [ ] Unreachable: shows the shared unreachable card instead of the table/filter/pager.

## Events (`/events`, `src/routes/events.tsx`)

Every normalised callback Meta sent — `reply` and `echo` are a human writing, `delivered` /
`read` / `failed` are Meta reporting on messages **we** sent.

- [ ] Copy: the count row above the grid reads `N events · replies X · echoes Y · …`, with
      `replies` and `echoes` present EVEN AT ZERO. On a workspace whose only traffic is its own
      delivery receipts it must read `2 events · replies 0 · echoes 0 · delivered 2` — never
      anything that suggests two customers wrote in.
- [ ] Visual: KIND is the event's own word in plain text, told apart by INK WEIGHT and not colour
      (reply/echo full-strength, delivered/read muted, failed red). No status tag on it.
- [ ] Visual: PARTY shows `from +34…` on a reply, `to +34…` on an echo, and `↳ #1042 <template>`
      on a status — a real link into the message sheet. When no message matches the wamid, the
      tail of the wamid, muted. Never the workspace's own phone id.
- [ ] Visual: DETAIL clamps to two lines and shows message text, or `131047 · <Meta's sentence>`
      on a failure, or `—` on a plain status. It must NEVER show a wamid.
- [ ] Visual: FORWARD is the batch's state in the forward vocabulary; `—` when the event has no
      batch (ingested before the link existed, or its batch aged out).
- [ ] Interaction: clicking a row opens the event sheet; the KIND cell is the focusable door that
      says so, and the PARTY link stops its own click so it opens the message rather than the row.
- [ ] Sheet: the "As forwarded" block shows the event JSON verbatim, plus how many other events
      rode in the same batch. The Forwarding section names the batch `#N`, its state, `n of 6`,
      the moment, and any last error in red; a held batch shows no invented next time.
- [ ] URL: opening a sheet writes `?event=<id>`; pasting that URL back opens the same sheet, and an
      id that is not on the page renders the "NOT IN THIS VIEW" state rather than nothing.
- [ ] Filter: the `<select>` narrows by forward state (`all forwards` / waiting / forwarded /
      failed); the count-row entries narrow by kind (`?kind=reply`).
- [ ] Pagination: same cursor contract as the queue.
- [ ] Empty state: "NO EVENTS YET" with no data; "No matches" plus a Clear-filters action when
      narrowed.
- [ ] Column visibility: PHONE appears only on a WABA with more than one number.
- [ ] Unreachable: shows the shared unreachable card.

## Messages (`/messages`, `src/routes/messages.tsx`)

- [ ] Visual: table (Created, To, Message, Meta, Trail, Error) renders; the MESSAGE cell reads
      `#1042 · template <name> · <lang>` and is the focusable door into the message sheet. The
      wamid must NOT appear in the table — it lives in full inside the sheet.
- [ ] Visual: META is `sent` / `failed` (Eccos → Meta) and TRAIL is `delivered · read` (Meta →
      phone), with a failed status in red carrying its Graph code. A failed send shows `—` in
      TRAIL, because without a wamid nothing can be about it.
- [ ] Sheet: facts (To, From number, Sent at, full Meta message id, Meta status, Error), the trail
      as rows with each event's own timestamp and the forward state of the batch that carried it,
      and the Request block showing the Meta body as sent.
- [ ] URL: `?message=<id>` addresses the sheet, same contract as /events.
- [ ] Filter: `all messages` / `sent` / `failed`, updating `?status=`; the Status page's
      per-status count links land here already filtered.
- [ ] Pagination: same cursor contract as the queue.
- [ ] Empty state: "NO MESSAGES YET"; "No matches" plus Clear filters when narrowed.
- [ ] Column visibility: PHONE appears only on a WABA with more than one number.
- [ ] Unreachable: shows the shared unreachable card.

## Templates (`/templates`, `src/routes/templates.tsx`)

- [ ] Visual: table (Name, Language, Status) renders; template status uses `StatusTag` coloring
      (approved=green, pending=amber, rejected=red).
- [ ] Empty state: "No templates found." shown when the list is empty.
- [ ] Second-layer error state: when the gateway is reachable but the Meta templates fetch itself
      failed, "Failed to load templates" renders with the error detail in a `<pre>` block — this is
      **distinct** from the outer unreachable state; verify both independently (e.g. by using an
      invalid Meta token vs. stopping the gateway entirely).
- [ ] Responsive: table wrapper scrolls horizontally at narrow widths.
- [ ] Unreachable (outer): shows the shared unreachable card when the `GATEWAY` binding itself is
      unreachable (gateway stopped).

## Webhooks (`/webhooks`, `src/routes/webhooks.tsx`)

Both legs of the plumbing live here: the forwarding target (Eccos → your receiver) and the
Meta callback (Meta → Eccos). The forwarding target and Re-subscribe moved here from
`/settings`.

- [ ] Visual: the header tag reads `NO TARGET` (amber) with no target configured and
      `FORWARDING` (green) with one. It is a fact, not a switch — there is nothing to click.
- [ ] Visual: the facts strip renders three rail-separated cells (`LAST FORWARD` · `ATTEMPTS` ·
      `SIGNING`) with no boxes; `failed` counts take the destructive ink and each count links
      into the filtered `/deliveries` view.
- [ ] Data: a delivery row that has NOT finished (`finished_at` null) reports `queued <time>`,
      never `finished <time>` — the arrival moment must never be shown as a completion.
- [ ] Empty state: with no target configured the panel shows `NO FORWARDING TARGET` plus one
      sentence, and the form itself is the action (no separate button).
- [ ] Form labels: the URL and Secret inputs have visible, correctly-associated `<label>`s
      (`htmlFor`/`id` pairs — confirm with devtools or a screen reader that clicking/announcing
      the label focuses/names the right input).
- [ ] Interaction: `Generate` fills the secret field with 64 hex characters (32 random bytes),
      minted in the browser.
- [ ] Interaction: `Show` / `Hide` appears ONLY while an unsaved value is in the field, and is
      gone again after a successful save — the console reveals only what it has not persisted.
- [ ] Interaction: submitting with an empty "Signing secret" field keeps the existing secret
      (the field is omitted from the request, never sent as `""`); after a successful save the
      field resets to empty and a green notice appears.
- [ ] Interaction: the secret `<input>` is `type="password"` (masked) with
      `autoComplete="new-password"` — confirm the stored value is never redisplayed; only
      `hasSecret` comes back from the gateway.
- [ ] Interaction: `Remove target` asks for confirmation, says the queue is HELD rather than
      failed afterwards, and keeps the signing secret. Confirming clears the URL and the header
      tag flips to `NO TARGET`.
- [ ] Interaction: "Save" and "Re-subscribe" disable themselves and show a busy label
      (`Saving…` / `Re-subscribing…`) while in flight, then re-enable.
- [ ] Interaction: "Re-subscribe" surfaces three distinct outcomes correctly — success (green,
      "Re-subscribed…"), gateway unreachable (red, RPC error text), and gateway-reachable-but-
      Meta-rejected (red, Meta's rejection reason) — these are different code paths, verify each.
- [ ] Visual: the "From Meta" panel renders only for an ACTIVE WABA, and shows the callback URL
      and connected-at (or `—`).
- [ ] Visual: the "Receiver reference" panel always renders, is control-free, and matches the
      forwarder in `apps/gateway/src/gateway.ts` (6 attempts, 5s→1h backoff, 5s timeout,
      redirects refused, `x-eccos-signature` only while a secret is set).
- [ ] One primary: Save is the only button carrying the brand glow; everything else is a ghost.
- [ ] Accessibility: notice boxes (success/error) are visually distinguishable by more than color
      alone (icon/wording) — check they wouldn't be missed by a colorblind operator.
- [ ] Unreachable: a failed `getSubscriberConfig` load renders the shared unreachable card.

## Settings (`/settings`, `src/routes/settings.tsx`)

- [ ] Visual: the Workspace panel shows the account id, in mono, and nothing else. The
      forwarding target, Re-subscribe and the pasted-token panel have all left this page.
- [ ] Reachable with no WABA at all (`requires: "none"`): the account id exists before a number
      does, and the page renders no failure card in that state.

## Attach by token (`/numbers/attach-token`, `src/routes/numbers_.attach-token.tsx`)

UNLISTED, on purpose: reachable by URL, absent from the sidebar, and linked from nowhere in the
interface (see the route's own comment).

- [ ] The route is NOT in the sidebar, and no page links to it — /numbers in particular must not
      offer a pointer to it.
- [ ] Visiting the URL directly renders a normal header band (kicker + heading) and the
      "Attach by token" panel, including its precondition sentence naming Embedded Signup.
- [ ] Reachable with zero WABAs (it is the way OUT of that state), and pasting a token issued by
      another Meta app is refused as `foreign_app` with the Embedded Signup remedy named.

## Auth gate (Cloudflare Access, `src/access.ts`)

Only exercisable against a real deployment with Access configured (see README); not reachable via
local `vite dev`.

- [ ] Visiting the dashboard's public URL directly (bypassing the Access login prompt, e.g. via an
      old bookmark or the raw `*.workers.dev` origin) without a valid `Cf-Access-Jwt-Assertion` /
      `CF_Authorization` cookie returns `403 Forbidden` — the operator UI never renders.
- [ ] Logging in through the configured Access application (correct team + policy) reaches the
      dashboard normally, and all 6 views load as usual.
- [ ] An expired Access session (or a session revoked in Zero Trust) is rejected on the next
      request (`403`), not just at initial login.
- [ ] With `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` unset (fresh deploy, no Access configured yet), a
      public dashboard request returns `403 Forbidden`; only localhost development is reachable.

## Planned follow-up

This checklist is deliberately manual — the dashboard has no browser-driving test harness today.
**Automated visual-regression testing (e.g. Playwright + screenshot snapshots per view, in both
the reachable and unreachable states, at a couple of viewport widths) is a planned follow-up**,
not yet implemented, so this document remains the source of truth for visual/UX QA until then.
