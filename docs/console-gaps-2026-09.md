# Console gaps — review of 2026-09-05

Seven observations from Santi, each checked against the code. Two are not what they looked
like from the outside, and that changes what the fix is; both are marked below.

Ordered by **cost-to-value**, not by the order they were reported. The first three are
small and unambiguous; the last two are the real work.

---

## 1. `/onboarding` is reachable once a workspace exists — one-word fix

**Verified.** `apps/dashboard/src/routes/__root.tsx:38` guards the route with
`state.data.stage === "ready"`. There are three stages, not two: `no-organization`,
`account-ready` (workspace exists, no active number) and `ready`. In `account-ready` the
guard never fires, so `/onboarding` renders and offers to create *another* workspace.

The comment directly above it already states the correct intent — *"an account that already
has a workspace must not land back on the step it completed"* — so this is a condition that
does not implement its own stated rule, not a missing decision.

**Fix.** `stage !== "no-organization"` instead of `stage === "ready"`. One line.

**Test.** The redirect fires in `account-ready`, not only in `ready`; `no-organization`
still reaches the page. Pin the three stages explicitly so the next stage added cannot
silently reopen the hole.

---

## 2. The setup checklist sends "Workspace" to `/onboarding`

**Verified.** `apps/dashboard/src/lib/setup-checklist.ts:50` sets `href: "/onboarding"` on
step 1, whose state is `done` whenever the checklist can be seen at all (its own comment
says so: reaching the shell means a membership resolved). So it is permanently a *done* row
whose link creates a duplicate of the thing it says is finished.

Doubly wrong, because the codebase already has the right destination: `/workspaces/new` is
the deliberate in-shell entry point for an additional workspace, and `__root.tsx:36`
documents that split.

**Fix — the decision, not just the link.** A completed step whose action is not repeatable
should not be a link at all. Render step 1 as text when `done`, and keep an href only in
the `todo` state (where the root loader is already force-redirecting anyway). If a link is
wanted for symmetry, it points at `/settings`, where the Workspace panel lives — never at a
route that creates something.

**Note.** Fixing #1 alone would turn this into a link that bounces to `/`, which is not a
fix, it is a silent dead end. Do both.

---

## 3. Delete is not styled as destructive — but it DOES already confirm

**Partly not what it looked like.** `DeleteTemplateDialog` is a real `AlertDialog` with
status-aware copy (`delete-template-dialog.tsx:24`, `deleteConfirmCopy`), it is reached
whenever the action column renders (`templates.tsx:225` gates the whole column on
`selectedWabaId`, the same value the dialog needs), and it is covered by tests. **The
confirmation step already exists.** Nothing to build there.

What is missing is that the trigger reads as ordinary: `templates.tsx:186` is
`variant="ghost"`, identical in weight to "Send test" beside it.

**Fix.** Give the trigger destructive ink. Note before picking a colour: `app.css` defines
`--color-destructive-foreground`, and there is an open bead about ~12 files using literal
hex for semantic ink — use the token, do not add a thirteenth literal. Keep it a ghost in
*anatomy* (no filled button: the page's one primary is elsewhere).

---

## 4. Templates cannot be previewed — the data is already there

**Verified, and cheaper than it looks.** `listTemplates`
(`packages/core/src/templates.ts:13`) requests `message_templates?limit=N` with **no
`fields` parameter**, so Meta returns its default set, which includes `components`. The
console already carries them: `templates.tsx:44` types the row with `components?: unknown`.
So the body, header, footer and buttons are in the browser and simply never rendered.

**Fix.** A preview surface showing the template as Meta will render it: header, body with
its `{{n}}` placeholders visible, footer, and the buttons with their labels. The
`send-test-sheet` already has `previewBody(bodyText, params)` — reuse it rather than writing
a second renderer.

**Decide** (this is the only open question here): a row-expansion, or a sheet opened by the
row like "Send test". A sheet matches the existing idiom and costs nothing new; expansion
shows more at once but the grid is a `LogGrid` and rows are not currently expandable.
Recommendation: sheet.

**No gateway work.** Contract unchanged, core unchanged.

---

## 5. "Send test" defers to the API on every template — the message is right, the send path is too narrow

**Not a bug in the message.** `lib/template-params.ts:75` (`analyzeTemplate`) refuses only
what the console genuinely cannot build, and each refusal names its real reason. Checked
against Citta's four production templates, all four legitimately hit it:

| template | why it refuses |
|---|---|
| `otp` | `AUTHENTICATION` — the console cannot mint a one-time code |
| `solicitud_recibida` | button URL `…/consultar-estado?t={{1}}` — dynamic URL parameter |
| `cita_encontrada` | same |
| `recordatorio_pago` | same |

So the console is being honest, and data rule 5 (no dead buttons) is being obeyed. **The
gap is upstream:** `SendTemplateTestInput` carries `bodyParams` and nothing else, so there
is no way to express a button URL parameter or a text-header parameter, and
`analyzeTemplate` correctly refuses rather than sending something Meta would reject with
132000.

**Fix, in order of value:**

1. **Button URL parameters.** This is the common case — it is what every one of Citta's
   real templates uses, and what any "click to confirm/pay" template uses. Widen
   `SendTemplateTestInput` with a button-parameter component, teach the gateway to build
   Meta's `components: [{type:"button", sub_type:"url", index:"0", parameters:[…]}]`, and
   drop the corresponding refusal.
2. **Text-header parameters.** `template-params.ts:112` refuses these with a comment
   explaining the real reason — mixing two positional groups is where the numbering starts
   lying to the operator. So this needs a UI that *labels* which group each input belongs
   to, not just another text box. Do it after 1, and only with that labelling.
3. **Leave refused:** `AUTHENTICATION` (the console must not mint OTPs — that is the
   customer's system's job), carousel, limited-time offer, media headers (need an uploaded
   asset), `COPY_CODE` / `OTP` / `FLOW` buttons, and named parameters. Each refusal keeps
   its sentence.

**Widening `SendTemplateTestInput` is a security decision, not a convenience one** — its
doc comment says so, and the reason stands: the gateway builds the Meta message itself so a
compromised console session can only ever produce a template send, never a freeform spam
pipe. Add *typed* button parameters; do not add a passthrough for arbitrary components.

**Cost:** contract + gateway + `analyzeTemplate` + the sheet + tests at each layer.

---

## 6. "Add another number" is always visible

**Verified.** `routes/numbers.tsx:94` renders `<ConnectNumberPanel heading="Add another
number" />` unconditionally beneath the table. The file already documents the two
placements as a deliberate pair (`:64-68`): centred and alone on first run, left-aligned
under the table afterwards.

That reasoning is about *alignment*, and it is right. It does not address *presence*: a
whole connect panel sitting open under the table makes adding a number look like a standing
part of the page rather than an occasional act.

**Fix.** Keep first-run exactly as it is — there the panel is the entire point of the
screen. In the populated state, collapse it behind a control (`+ Add number`, ghost,
`aria-expanded`) that unfolds the existing panel. Same component, one more state.

**Watch:** the `/numbers/attach-token` decision means nothing on this page may point at the
token route. The disclosure must not grow a "or attach by token" line — see the JSX comment
at `numbers.tsx:73` that exists precisely to stop that.

---

## 7. "New template" is very limited

**Verified, and it is limited by construction, not by oversight.**
`packages/core/src/templates.ts:30` says it in the type's own doc: *"One body-only text
template, as the console authors it."* `CreateTemplateBody` is `{name, language, category,
bodyText, examples}`. The sheet offers 10 languages and 2 categories
(`create-template-sheet.tsx:36,51`).

Missing, in rough order of how often a real template needs it:

| gap | note |
|---|---|
| **Footer** | Cheapest by far — static text, no parameters, no examples. Citta uses one on all four templates. |
| **Text header** | Static first, parameterised later (same numbering trap as §5.2). |
| **URL buttons** | Static and dynamic. Pairs naturally with §5.1 — build the send and the authoring together, or the console will create templates it cannot send. |
| **Quick-reply buttons** | Needs inbound button-payload handling to be worth anything; check what the parser does with them first. |
| **Media header** | Needs an uploaded asset and a handle from Meta's resumable upload API. Real work; defer. |
| **More languages** | The list is hardcoded; Meta supports ~60. Trivial, but decide whether a long select or a searchable combobox. |
| **AUTHENTICATION category** | Deliberately excluded (`rpc.ts` comment: preset content + OTP buttons, a different creation shape). Keep excluded. |

**Sequencing that matters:** do **footer** and **static URL buttons** with §5.1, in one
pass. Authoring a template the console then refuses to send is a worse experience than not
authoring it at all.

---

## Suggested order

**Round 1 — small, unambiguous, ship together**
1. §1 the onboarding guard (one line)
2. §2 the checklist link
3. §3 destructive ink on Delete
4. §6 collapse "Add another number"

**Round 2 — visible value, no contract change**
5. §4 the template preview sheet

**Round 3 — the real work, one pass**
6. §5.1 button URL parameters on send + §7 footer and URL buttons on create
7. §5.2 header parameters, with the group labelling

Rounds 1 and 2 are independent of each other and of Round 3. Round 3 should not be split
across the send and the create halves.

---

## Two things this review changed about the report

- **The delete confirmation already exists** (§3). Only the colour is missing.
- **The "send it through the API" message is correct** (§5), and refusing was the right
  call — it obeys the no-dead-buttons rule. What is missing is the ability to *fill in* a
  button parameter, which is one level up from where it looked like the problem was.

## Tracking

`CLAUDE.md` says to use `bd` for all task tracking and not markdown TODO lists. This file
is the analysis, written because it was asked for; the work items should be filed as beads
before any of it starts, and this file referenced from them rather than duplicated.
