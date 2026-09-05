import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createTemplate } from "../../server/gateway";
import type { CreateTemplateResult } from "../../server/gateway";
import { createTemplateFailureCopy, failureCopy } from "../../lib/failure";
import {
  analyzeDraftBody,
  analyzeDraftButtons,
  analyzeDraftFooter,
  draftWarnings,
  MAX_CREATE_BUTTONS,
  normalizeTemplateName,
  previewBody,
  type DraftButton,
} from "../../lib/template-params";

/**
 * Languages offered in the picker.
 *
 * A curated constant, not Meta's full list: every entry here is a promise that
 * the console renders its locale code correctly, and the list Meta accepts runs
 * to hundreds. Extending it is adding a line. A template's name is unique per
 * name+LANGUAGE pair, so this is also the second half of a row's identity.
 */
const LANGUAGES: { code: string; label: string }[] = [
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "es_ES", label: "Spanish (Spain)" },
  { code: "es_MX", label: "Spanish (Mexico)" },
  { code: "pt_BR", label: "Portuguese (Brazil)" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ca", label: "Catalan" },
];

/** AUTHENTICATION is absent by design: those templates are preset content plus
 * OTP buttons — a different creation shape, not a missing option. */
const CATEGORIES: { value: TemplateCategory; label: string }[] = [
  { value: "UTILITY", label: "Utility" },
  { value: "MARKETING", label: "Marketing" },
];

export type TemplateCategory = "MARKETING" | "UTILITY";

/** Everything the operator is typing. Held by `useCreateTemplateDraft`, rendered
 * by `CreateTemplateFields` — the split exists so the fields can be rendered in
 * any state without driving a browser. */
export interface TemplateDraft {
  name: string;
  language: string;
  category: TemplateCategory;
  body: string;
  /** Example values by position. Only ever grown, which is what preserves a
   * value when its variable is removed from the body and typed back. */
  examples: string[];
  /** Static footer shown under the body. No placeholders, within Meta's
   * ceiling; empty means no footer component. */
  footer: string;
  /** URL buttons in BUTTONS order (at most three). A URL that carries a
   * `{{n}}` placeholder is dynamic and REQUIRES an example URL. */
  buttons: DraftButton[];
}

export const EMPTY_DRAFT: TemplateDraft = {
  name: "",
  language: "en_US",
  category: "UTILITY",
  body: "",
  examples: [],
  footer: "",
  buttons: [],
};

/**
 * Does this draft hold anything the operator would lose?
 *
 * The question is CONTENT, not shape: a button row added and left blank costs
 * one click to recreate and does not count, while a language or a category
 * moved off its default is a deliberate choice and does. Pure and exported
 * because it is the seam the dismissal guard is tested through — the sheet is a
 * Base UI portal, and a static render cannot open one.
 */
export function isDraftDirty(draft: TemplateDraft): boolean {
  return (
    draft.name.trim() !== "" ||
    draft.body.trim() !== "" ||
    draft.footer.trim() !== "" ||
    draft.language !== EMPTY_DRAFT.language ||
    draft.category !== EMPTY_DRAFT.category ||
    // The examples array is only ever grown, so a value typed for a variable
    // that has since left the body is still a value on screen to lose.
    draft.examples.some((value) => value.trim() !== "") ||
    draft.buttons.some(
      (button) =>
        button.text.trim() !== "" ||
        button.url.trim() !== "" ||
        button.exampleUrl.trim() !== "",
    )
  );
}

/**
 * Must an accidental dismissal be refused right now?
 *
 * Three answers in one predicate, because they are one question — "is there
 * anything behind this sheet that a stray click would destroy?":
 *
 * - A submit in flight always guards: unmounting the sheet under a pending
 *   request throws away Meta's answer to a creation that may already have
 *   succeeded.
 * - The exact draft object Meta has ALREADY accepted never guards. What is on
 *   screen then is a receipt, not unsaved work. The comparison is by reference
 *   on purpose: every edit produces a new draft object, so the guard re-arms
 *   the moment the operator types again.
 * - Otherwise a dirty draft guards and a pristine one does not — "opened it by
 *   mistake" is the common case and must stay one press away from closing.
 */
export function shouldGuardDismissal(state: {
  draft: TemplateDraft;
  submitting: boolean;
  createdDraft: TemplateDraft | null;
}): boolean {
  if (state.submitting) return true;
  if (state.createdDraft === state.draft) return false;
  return isDraftDirty(state.draft);
}

export type CreateTemplateNotice =
  | { ok: true; id: string; status: string; recategorizedTo: string | null }
  | { ok: false; title: string; detail: string; secondary?: string };

/**
 * The example values that belong to this draft, derived from its BODY.
 *
 * Derived, never stored beside the body, so the inputs and the placeholders can
 * never desync: the count comes from `analyzeDraftBody`, and a position the
 * operator has not reached yet reads as "".
 */
export function exampleValues(draft: TemplateDraft): string[] {
  const analysis = analyzeDraftBody(draft.body);
  const count = analysis.ok ? analysis.paramCount : 0;
  return Array.from({ length: count }, (_, index) => draft.examples[index] ?? "");
}

/** Best-effort deep link into WhatsApp Manager's template list for this WABA. */
function managerUrl(wabaId: string): string {
  return `https://business.facebook.com/wa/manage/message-templates/?waba_id=${encodeURIComponent(wabaId)}`;
}

const LABEL = "mb-1 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
const HELP = "mt-1 m-0 max-w-prose text-xs text-pretty text-muted-foreground";

export interface CreateTemplateFieldsProps {
  wabaId: string;
  draft: TemplateDraft;
  onDraftChange: (draft: TemplateDraft) => void;
  submitting: boolean;
  notice: CreateTemplateNotice | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/**
 * The authoring form itself: name, language, category, body, one example per
 * variable, the live preview, and the submit.
 *
 * Fully controlled, like `WorkspaceFormFields` and for the same reason — state
 * lives in the component that submits, so the fields can be rendered in every
 * state (blocked draft, warning, success notice) without a browser.
 */
export function CreateTemplateFields({
  wabaId,
  draft,
  onDraftChange,
  submitting,
  notice,
  onSubmit,
}: CreateTemplateFieldsProps) {
  const analysis = analyzeDraftBody(draft.body);
  const warnings = draftWarnings(draft.body);
  const values = exampleValues(draft);
  const footerAnalysis = analyzeDraftFooter(draft.footer);
  const buttonsAnalysis = analyzeDraftButtons(draft.buttons);
  const blocked = !analysis.ok && draft.body.length > 0;
  const footerBlocked = !footerAnalysis.ok && draft.footer.length > 0;
  const buttonsBlocked = !buttonsAnalysis.ok;

  function setExample(index: number, value: string) {
    const examples = [...draft.examples];
    while (examples.length <= index) examples.push("");
    examples[index] = value;
    onDraftChange({ ...draft, examples });
  }

  function setFooter(value: string) {
    onDraftChange({ ...draft, footer: value });
  }

  function setButton(index: number, patch: Partial<DraftButton>) {
    onDraftChange({
      ...draft,
      buttons: draft.buttons.map((button, i) => (i === index ? { ...button, ...patch } : button)),
    });
  }

  function addButton() {
    if (draft.buttons.length >= MAX_CREATE_BUTTONS) return;
    onDraftChange({ ...draft, buttons: [...draft.buttons, { text: "", url: "", exampleUrl: "" }] });
  }

  function removeButton(index: number) {
    onDraftChange({ ...draft, buttons: draft.buttons.filter((_, i) => i !== index) });
  }

  const preview = draft.body ? previewBody(draft.body, values) : null;

  return (
    <form onSubmit={onSubmit} aria-busy={submitting} className="flex flex-col gap-4 px-4 pb-4">
      <div>
        <label htmlFor="create-template-name" className={LABEL}>
          Name
        </label>
        <Input
          id="create-template-name"
          required
          autoComplete="off"
          className="font-mono"
          value={draft.name}
          // Coerced as it is typed — WhatsApp Manager's own behaviour — so the
          // field can never show a name Meta would reject.
          onChange={(event) =>
            onDraftChange({ ...draft, name: normalizeTemplateName(event.target.value) })
          }
          placeholder="order_update"
        />
        <p className={HELP}>Lowercase letters, numbers and underscores.</p>
      </div>

      <div>
        <label htmlFor="create-template-language" className={LABEL}>
          Language
        </label>
        <Select
          value={draft.language}
          onValueChange={(value) => onDraftChange({ ...draft, language: value ?? "en_US" })}
        >
          <SelectTrigger id="create-template-language" size="sm" className="w-full rounded-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" className="min-w-(--anchor-width)">
            {LANGUAGES.map((entry) => (
              <SelectItem key={entry.code} value={entry.code}>
                {entry.label} {"·"} {entry.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className={HELP}>A template name is unique per language, not on its own.</p>
      </div>

      <div>
        <label htmlFor="create-template-category" className={LABEL}>
          Category
        </label>
        <Select
          value={draft.category}
          onValueChange={(value) =>
            onDraftChange({ ...draft, category: (value as TemplateCategory) ?? "UTILITY" })
          }
        >
          <SelectTrigger id="create-template-category" size="sm" className="w-full rounded-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" className="min-w-(--anchor-width)">
            {CATEGORIES.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className={HELP}>
          Meta reviews the category and may reassign it. Authentication templates are created in
          WhatsApp Manager.
        </p>
      </div>

      <div>
        <label htmlFor="create-template-body" className={LABEL}>
          Body
        </label>
        <Textarea
          id="create-template-body"
          required
          rows={4}
          value={draft.body}
          onChange={(event) => onDraftChange({ ...draft, body: event.target.value })}
          placeholder="Hi {{1}}, your order is on its way."
          aria-invalid={blocked}
          aria-describedby={blocked ? "create-template-body-error" : undefined}
        />
        <p className={HELP}>{"Use {{1}}, {{2}}… for values filled at send time."}</p>
        {blocked && !analysis.ok ? (
          // The blocker sentence IS the reason the submit button is off, and it
          // is on screen rather than in a tooltip — which is what keeps a
          // disabled button from being a dead one (data rule 5).
          <p
            id="create-template-body-error"
            className="mt-1 m-0 max-w-prose text-xs text-pretty text-[#ff7777]"
          >
            {analysis.reason}
          </p>
        ) : null}
        {warnings.map((warning) => (
          // Amber, and never a wall: these are reseller-reported review
          // heuristics, not rules Meta publishes. See `draftWarnings`.
          <p key={warning} className="mt-1 m-0 max-w-prose text-xs text-pretty text-[#f0a020]">
            {warning}
          </p>
        ))}
      </div>

      {values.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 max-w-prose text-xs text-pretty text-muted-foreground">
            Sample values shown to Meta's reviewers. Never sent to anyone.
          </p>
          {values.map((value, index) => (
            // Positional parameters have no names, so the index IS the identity
            // — the list never reorders and its length is fixed by the body.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional by definition
            <div key={index}>
              <label htmlFor={`create-template-example-${index + 1}`} className={LABEL}>
                {`Example {{${index + 1}}}`}
              </label>
              <Input
                id={`create-template-example-${index + 1}`}
                required
                autoComplete="off"
                value={value}
                onChange={(event) => setExample(index, event.target.value)}
              />
            </div>
          ))}
        </div>
      ) : null}

      <div>
        <label htmlFor="create-template-footer" className={LABEL}>
          Footer
        </label>
        <Input
          id="create-template-footer"
          autoComplete="off"
          value={draft.footer}
          onChange={(event) => setFooter(event.target.value)}
          placeholder="Powered by Eccos"
          aria-invalid={footerBlocked}
          aria-describedby={footerBlocked ? "create-template-footer-error" : undefined}
        />
        <p className={HELP}>Static text shown under the body. No variables.</p>
        {footerBlocked && !footerAnalysis.ok ? (
          <p
            id="create-template-footer-error"
            className="mt-1 m-0 max-w-prose text-xs text-pretty text-[#ff7777]"
          >
            {footerAnalysis.reason}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <p className={LABEL}>Buttons</p>
        {draft.buttons.map((button, index) => {
          const dynamic = button.url.includes("{{");
          return (
            <div key={index} className="flex flex-col gap-3 border border-(--line) p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">Button {index + 1}</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline underline-offset-4"
                  onClick={() => removeButton(index)}
                >
                  Remove
                </button>
              </div>
              <div>
                <label htmlFor={`create-template-button-${index}-text`} className={LABEL}>
                  Label
                </label>
                <Input
                  id={`create-template-button-${index}-text`}
                  autoComplete="off"
                  value={button.text}
                  onChange={(event) => setButton(index, { text: event.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`create-template-button-${index}-url`} className={LABEL}>
                  URL
                </label>
                <Input
                  id={`create-template-button-${index}-url`}
                  autoComplete="off"
                  value={button.url}
                  onChange={(event) => setButton(index, { url: event.target.value })}
                  placeholder="https://example.com/…"
                />
              </div>
              {dynamic ? (
                <div>
                  <label htmlFor={`create-template-button-${index}-example`} className={LABEL}>
                    Example URL
                  </label>
                  <Input
                    id={`create-template-button-${index}-example`}
                    autoComplete="off"
                    value={button.exampleUrl}
                    onChange={(event) => setButton(index, { exampleUrl: event.target.value })}
                    placeholder="https://example.com/…"
                  />
                  <p className={HELP}>Required: this is what Meta's reviewers read.</p>
                </div>
              ) : null}
            </div>
          );
        })}
        {buttonsBlocked && !buttonsAnalysis.ok ? (
          <p className="m-0 max-w-prose text-xs text-pretty text-[#ff7777]">
            {buttonsAnalysis.reason}
          </p>
        ) : null}
        {draft.buttons.length < MAX_CREATE_BUTTONS ? (
          <button
            type="button"
            onClick={addButton}
            className="w-fit text-xs text-muted-foreground underline underline-offset-4"
          >
            + Add button
          </button>
        ) : null}
      </div>

      {preview ? (
        <div>
          <span className={LABEL}>Preview</span>
          <p className="m-0 font-mono text-[11px] break-all text-muted-foreground">
            {draft.name || "—"} {"·"} {draft.language} {"·"} {draft.category}
          </p>
          {/* The panel is what the operator confirms BEFORE submitting, so it
              draws exactly what the form now authors, in Meta's order: the
              substituted body, then the footer, then every URL button with its
              label and its URL. A typed footer or button that never reached
              this panel would be the same contradiction class as the
              collected-but-never-sent button params, so it must not be
              invisible here. */}
          <p className="mt-1 m-0 border border-(--line) bg-muted p-3 text-sm whitespace-pre-wrap text-foreground">
            {preview}
          </p>
          {draft.footer.trim() ? (
            <p className="mt-1 m-0 border border-(--line) bg-muted p-3 text-sm whitespace-pre-wrap text-foreground">
              {draft.footer}
            </p>
          ) : null}
          {draft.buttons.length > 0 ? (
            <div className="mt-1 flex flex-col gap-2">
              {draft.buttons.map((button, index) => (
                // Buttons have no names - the authoring order IS the identity,
                // the same convention the template preview sheet applies.
                // biome-ignore lint/suspicious/noArrayIndexKey: positional by definition
                <div key={index} className="flex flex-col gap-1 border border-(--line) p-2.5">
                  <span className="text-sm text-foreground">{button.text}</span>
                  {button.url ? (
                    // A dynamic URL keeps its `{{n}}` literal - there are no
                    // values to fill in this panel, the same convention as the
                    // template preview sheet.
                    <span className="font-mono text-xs break-all text-muted-foreground">
                      {button.url}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <Button
        type="submit"
        className="w-fit self-start"
        aria-busy={submitting}
        disabled={submitting || !analysis.ok || footerBlocked || buttonsBlocked}
      >
        {submitting ? "Submitting…" : "Create template"}
      </Button>

      {/* Mounted even when empty: a live region that appears with its message is
          not reliably announced, one that fills up is. */}
      <output
        aria-live="polite"
        aria-atomic="true"
        className={notice ? "block border-l-2 border-l-(--line-strong) px-3 py-2" : undefined}
      >
        {notice ? <NoticeBody notice={notice} /> : null}
      </output>

      <p className="m-0 max-w-prose text-xs text-pretty text-muted-foreground">
        {"The console creates text templates: a body with positional variables ({{1}}, {{2}}…), an optional footer, and up to three URL buttons. "}
        {"For media headers, carousels, authentication templates, or quick-reply buttons, use "}
        <a
          href={managerUrl(wabaId)}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4"
        >
          WhatsApp Manager
        </a>
        .
      </p>
    </form>
  );
}

interface CreateTemplateDraftProps {
  wabaId: string;
  /** Called once Meta accepts the template, so the route can re-read the list
   * and show the new PENDING row without a manual refresh. */
  onCreated?: () => void;
}

/**
 * "New template" — authoring one message template from the console.
 *
 * The scope is the exact inverse of what the "Send test" sheet can build: a
 * BODY with positional `{{1}}..{{n}}` parameters, an optional static footer,
 * and up to three URL buttons (static or `{{n}}`-dynamic, in which case the
 * example URL is mandatory). That is not a coincidence and not a limitation to
 * relax casually — the creation surface has to be a SUBSET of the send
 * surface, or the console would author templates its own send sheet then
 * refuses. `analyzeDraftBody`, `analyzeDraftFooter`, `analyzeDraftButtons`
 * and `analyzeTemplate` live in one module for exactly that reason.
 *
 * A hook rather than state inside a form component because the SHEET has to
 * read the same draft: its dismissal guard is a question about this state
 * ("is there anything here to lose?"), and asking the form through a callback
 * would make a second, lagging copy of the answer.
 */
function useCreateTemplateDraft({ wabaId, onCreated }: CreateTemplateDraftProps) {
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<CreateTemplateNotice | null>(null);
  /** The exact draft object Meta accepted, so the guard can tell a receipt
   * from unsaved work. Null until a creation succeeds. */
  const [createdDraft, setCreatedDraft] = useState<TemplateDraft | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const analysis = analyzeDraftBody(draft.body);
    if (!analysis.ok) return;
    setSubmitting(true);
    setNotice(null);
    setCreatedDraft(null);
    try {
      const values = exampleValues(draft);
      const result = await createTemplate({
        data: {
          wabaId,
          name: draft.name,
          language: draft.language,
          category: draft.category,
          bodyText: draft.body,
          ...(values.length > 0 ? { bodyExamples: values } : {}),
          ...(draft.footer.trim() ? { footerText: draft.footer } : {}),
          ...(draft.buttons.filter((button) => button.text.trim() && button.url.trim()).length > 0
            ? {
                buttons: draft.buttons
                  .filter((button) => button.text.trim() && button.url.trim())
                  .map((button) => ({
                    text: button.text,
                    url: button.url,
                    ...(button.url.includes("{{") && button.exampleUrl
                      ? { exampleUrl: button.exampleUrl }
                      : {}),
                  })),
              }
            : {}),
        },
      });
      if (!result.ok) {
        // A boundary failure (unreachable / unauthenticated / forbidden) is a
        // different class from a refused creation, and keeps its own mapping.
        const copy = failureCopy(result);
        setNotice({ ok: false, title: copy.title, detail: copy.detail });
        return;
      }
      setNotice(noticeFor(result.data, draft.category));
      if (result.data.ok) {
        setCreatedDraft(draft);
        onCreated?.();
      }
    } finally {
      setSubmitting(false);
    }
  }

  return { draft, setDraft, submitting, notice, createdDraft, onSubmit };
}

/** Per-code copy, never a raw Graph payload. */
export function noticeFor(result: CreateTemplateResult, requested: string): CreateTemplateNotice {
  if (result.ok) {
    return {
      ok: true,
      id: result.id,
      status: result.status,
      // Meta recategorises on its own — `allow_category_change` is now the
      // default behaviour — so the console reports its ANSWER, not the
      // operator's request, and says so when the two differ.
      recategorizedTo: result.category && result.category !== requested ? result.category : null,
    };
  }
  const copy = createTemplateFailureCopy(result.code, result.detail);
  return {
    ok: false,
    title: copy.title,
    detail: copy.detail,
    // Meta's own sentence explains; it never discriminates, so it sits under
    // the console's words as a secondary line and only when it adds something.
    // `name_taken` and `rate_limited` are fully explained by the console's own
    // copy, so Graph's wording would only add noise there.
    ...((result.code === "graph" || result.code === "invalid") && result.detail
      ? { secondary: result.detail }
      : {}),
  };
}

function NoticeBody({ notice }: { notice: CreateTemplateNotice }) {
  if (notice.ok) {
    return (
      <span className="block text-sm text-foreground">
        <span className="font-mono text-xs break-all">
          Submitted for review {"·"} {notice.status} {"·"} {notice.id}
        </span>
        {notice.recategorizedTo ? (
          <span className="mt-1 block text-sm text-muted-foreground">
            Meta categorized this template as {notice.recategorizedTo}.
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="block">
      <span className="block text-sm text-[#ff7777]">{notice.title}</span>
      <span className="block text-sm text-muted-foreground">{notice.detail}</span>
      {notice.secondary ? (
        <span className="mt-1 block font-mono text-xs break-words text-muted-foreground">
          {notice.secondary}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The sheet around the form, and the guard that keeps a draft from evaporating.
 *
 * The title lives here rather than in the fields because Base UI's
 * `Dialog.Title` needs the dialog context — which is also why the fields are
 * what the tests render.
 *
 * This sheet holds a document, not a menu: a name, a language, a category, a
 * body with its per-position examples, a footer and up to three URL buttons.
 * The backdrop behind it is `bg-black/10`, all but invisible, so the two
 * cheapest gestures in the room used to destroy all of it silently. They get
 * two different answers, because they mean two different things:
 *
 * - A press OUTSIDE is not an intent to close, it is a click on the table
 *   behind — usually to check the name of an existing row. While the guard is
 *   armed `disablePointerDismissal` turns it into nothing at all; popping a
 *   question at every stray click would be its own kind of rude.
 * - Escape and the close button ARE deliberate, so they are answered rather
 *   than ignored: Base UI's close is cancelled and the discard confirmation
 *   asks once. The way out never disappears — it costs one more press.
 *
 * An untouched draft skips all of it and closes on the first press, because
 * "opened it by mistake" is the common case and must stay free.
 */
export function CreateTemplateSheet({
  open,
  onOpenChange,
  wabaId,
  onCreated,
}: CreateTemplateDraftProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useCreateTemplateDraft({ wabaId, onCreated });
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const guarded = shouldGuardDismissal(form);

  return (
    <Sheet
      open={open}
      disablePointerDismissal={guarded}
      onOpenChange={(next, details) => {
        if (next || !guarded) {
          onOpenChange(next);
          return;
        }
        details.cancel();
        setConfirmingDiscard(true);
      }}
    >
      <SheetContent side="right" className="w-full gap-2 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-2">
          <SheetTitle className="text-sm">New template</SheetTitle>
        </SheetHeader>
        <CreateTemplateFields
          wabaId={wabaId}
          draft={form.draft}
          onDraftChange={form.setDraft}
          submitting={form.submitting}
          notice={form.notice}
          onSubmit={form.onSubmit}
        />
        {/* Nested INSIDE the sheet's popup, not beside it: Base UI reads the
            parent dialog from React context, and that is what lets the
            confirmation take focus without two modals fighting over it. */}
        {confirmingDiscard ? (
          <DiscardDraftDialog
            submitting={form.submitting}
            onOpenChange={(next) => {
              if (!next) setConfirmingDiscard(false);
            }}
            onDiscard={() => {
              setConfirmingDiscard(false);
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** What abandoning the draft actually costs, in the operator's terms — and it
 * costs something different mid-flight. Exported so the wording is asserted
 * directly, the same way `deleteConfirmCopy` is. */
export function discardDraftCopy(submitting: boolean): string {
  return submitting
    ? "This template is still being submitted. Closing now abandons Meta's answer to a creation that may already have succeeded."
    : "Nothing has been created yet. The name, body, examples, footer and buttons typed here are lost.";
}

/**
 * The one question standing between a dirty draft and losing it.
 *
 * In the AlertDialog register, like `DeleteTemplateDialog`: modal, no pointer
 * dismissal, and the act behind it is irreversible. Escape still closes THIS
 * dialog, which is exactly right — Escape means Cancel, and cancelling here
 * means the draft survives.
 */
function DiscardDraftDialog({
  submitting,
  onOpenChange,
  onDiscard,
}: {
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
          <AlertDialogDescription>{discardDraftCopy(submitting)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction type="button" onClick={onDiscard}>
            Discard draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
