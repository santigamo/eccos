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
import { createTemplate } from "../../server/gateway";
import type { CreateTemplateResult } from "../../server/gateway";
import { createTemplateFailureCopy, failureCopy } from "../../lib/failure";
import {
  analyzeDraftBody,
  draftWarnings,
  normalizeTemplateName,
  previewBody,
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

/** Everything the operator is typing. Held by `CreateTemplateForm`, rendered by
 * `CreateTemplateFields` — the split exists so the fields can be rendered in
 * any state without driving a browser. */
export interface TemplateDraft {
  name: string;
  language: string;
  category: TemplateCategory;
  body: string;
  /** Example values by position. Only ever grown, which is what preserves a
   * value when its variable is removed from the body and typed back. */
  examples: string[];
}

export const EMPTY_DRAFT: TemplateDraft = {
  name: "",
  language: "en_US",
  category: "UTILITY",
  body: "",
  examples: [],
};

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
  const blocked = !analysis.ok && draft.body.length > 0;

  function setExample(index: number, value: string) {
    const examples = [...draft.examples];
    while (examples.length <= index) examples.push("");
    examples[index] = value;
    onDraftChange({ ...draft, examples });
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

      {preview ? (
        <div>
          <span className={LABEL}>Preview</span>
          <p className="m-0 font-mono text-[11px] break-all text-muted-foreground">
            {draft.name || "—"} {"·"} {draft.language} {"·"} {draft.category}
          </p>
          {/* Quiet and inert: `--ghost-fill` is the ghost CONTROL body, and a
              preview that wore it would read as something to click. Square and
              `bg-muted`, exactly like the send sheet's preview — what must not
              lie is the CONTENT (the text, the substituted values, the line
              breaks, the unfilled slots); the container is chrome, and a
              rounded bubble here would make the console contradict itself
              sheet to sheet. */}
          <p className="mt-1 m-0 border border-(--line) bg-muted p-3 text-sm whitespace-pre-wrap text-foreground">
            {preview}
          </p>
        </div>
      ) : null}

      <Button
        type="submit"
        className="w-fit self-start"
        aria-busy={submitting}
        disabled={submitting || !analysis.ok}
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
        {"The console creates text templates: a body with positional variables ({{1}}, {{2}}…). "}
        {"For media headers, buttons, carousels, or authentication templates, use "}
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

interface CreateTemplateFormProps {
  wabaId: string;
  /** Called once Meta accepts the template, so the route can re-read the list
   * and show the new PENDING row without a manual refresh. */
  onCreated?: () => void;
}

/**
 * "New template" — authoring one message template from the console.
 *
 * The scope is the exact inverse of what the "Send test" sheet can build: a
 * BODY with positional `{{1}}..{{n}}` parameters, nothing else. That is not a
 * coincidence and not a limitation to relax casually — the creation surface has
 * to be a SUBSET of the sending surface, or the console would author templates
 * its own send sheet then refuses. `analyzeDraftBody` and `analyzeTemplate`
 * live in one module for exactly that reason.
 */
export function CreateTemplateForm({ wabaId, onCreated }: CreateTemplateFormProps) {
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<CreateTemplateNotice | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const analysis = analyzeDraftBody(draft.body);
    if (!analysis.ok) return;
    setSubmitting(true);
    setNotice(null);
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
      if (result.data.ok) onCreated?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CreateTemplateFields
      wabaId={wabaId}
      draft={draft}
      onDraftChange={setDraft}
      submitting={submitting}
      notice={notice}
      onSubmit={onSubmit}
    />
  );
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
 * The sheet around the form.
 *
 * The title lives here rather than in `CreateTemplateForm` because Base UI's
 * `Dialog.Title` needs the dialog context — which is also why the fields are
 * what the tests render.
 */
export function CreateTemplateSheet({
  open,
  onOpenChange,
  wabaId,
  onCreated,
}: CreateTemplateFormProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-2 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-2">
          <SheetTitle className="text-sm">New template</SheetTitle>
        </SheetHeader>
        <CreateTemplateForm wabaId={wabaId} onCreated={onCreated} />
      </SheetContent>
    </Sheet>
  );
}
