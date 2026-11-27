import { useRef } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  analyzeDraftBody,
  analyzeDraftButtons,
  analyzeDraftFooter,
  draftWarnings,
  isDynamicUrl,
  MAX_BODY_LENGTH,
  MAX_CREATE_BUTTONS,
} from "@eccos/core/template-rules";
import { MACHINE_CLASS } from "../dashboard/plain-table";
import { coreButtons, exampleValues, type ButtonDraft, type LanguageDraft } from "../../lib/template-draft";
import type { ReadOnlyContent } from "../../lib/template-group";
import { managerUrl } from "../../lib/template-view";

const LABEL = `mb-1 block ${MACHINE_CLASS}`;
const HELP = "m-0 mt-1 max-w-prose text-xs text-pretty text-muted-foreground";
const ERROR = "m-0 mt-1 max-w-prose text-xs text-pretty text-destructive-foreground";
/** Label | URL | remove, one row per button. */
const BUTTON_ROW = "grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_2rem] items-center gap-3";

/** The next positional variable a body can take. */
function nextVariable(body: string): number {
  const analysis = analyzeDraftBody(body);
  if (analysis.ok) return analysis.paramCount + 1;
  const numbers = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((match) => Number(match[1]));
  return Math.max(0, ...numbers) + 1;
}

/**
 * One language's content as the operator edits it: the body with its examples
 * hung under it, the footer, and the link buttons. Fully controlled, so every
 * state renders without a browser.
 */
export function LanguageFields({
  draft,
  onChange,
  wabaId,
}: {
  draft: LanguageDraft;
  onChange: (draft: LanguageDraft) => void;
  wabaId: string;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const analysis = analyzeDraftBody(draft.body);
  const bodyBlocked = !analysis.ok && draft.body.length > 0;
  const footer = analyzeDraftFooter(draft.footer);
  const footerBlocked = !footer.ok && draft.footer.length > 0;
  const buttons = analyzeDraftButtons(coreButtons(draft));
  const values = exampleValues(draft);
  const variable = nextVariable(draft.body);

  function insertVariable() {
    const token = `{{${variable}}}`;
    const at = bodyRef.current?.selectionStart ?? draft.body.length;
    onChange({ ...draft, body: draft.body.slice(0, at) + token + draft.body.slice(at) });
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(at + token.length, at + token.length);
    });
  }

  function setExample(index: number, value: string) {
    const examples = [...draft.examples];
    while (examples.length <= index) examples.push("");
    examples[index] = value;
    onChange({ ...draft, examples });
  }

  function setButton(index: number, patch: Partial<ButtonDraft>) {
    onChange({ ...draft, buttons: draft.buttons.map((button, i) => (i === index ? { ...button, ...patch } : button)) });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-end justify-between gap-4">
          <label htmlFor="template-body" className={LABEL}>
            Body
          </label>
          <button type="button" onClick={insertVariable} className="mb-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
            {`Insert variable {{${variable}}}`}
          </button>
        </div>
        <Textarea
          ref={bodyRef}
          id="template-body"
          rows={6}
          className="min-h-32 text-sm md:text-sm"
          value={draft.body}
          onChange={(event) => onChange({ ...draft, body: event.target.value })}
          placeholder="Hi {{1}}, your order is on its way."
          aria-invalid={bodyBlocked}
          aria-describedby={bodyBlocked ? "template-body-error" : undefined}
        />
        <div className="mt-1 flex justify-between gap-4">
          <p className="m-0 text-xs text-muted-foreground">{"{{1}}, {{2}}… are filled in when you send."}</p>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {`${draft.body.length} / ${MAX_BODY_LENGTH}`}
          </span>
        </div>
        {bodyBlocked && !analysis.ok ? (
          <p id="template-body-error" className={ERROR}>
            {analysis.reason}
          </p>
        ) : null}
        {draftWarnings(draft.body).map((warning) => (
          // Amber, and never a wall: reseller-reported review heuristics, not Meta's rules.
          <p key={warning} className="m-0 mt-1 max-w-prose text-xs text-pretty text-warning-foreground">
            {warning}
          </p>
        ))}
        {values.length > 0 ? (
          <div className="mt-3 flex flex-col gap-3 border-l border-(--line) pl-4">
            <p className="m-0 text-xs text-muted-foreground">Sample values for Meta's reviewers. Never sent to anyone.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {values.map((value, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional by definition
                <div key={index}>
                  <label htmlFor={`template-example-${index + 1}`} className={LABEL}>
                    {`Example {{${index + 1}}}`}
                  </label>
                  <Input
                    id={`template-example-${index + 1}`}
                    autoComplete="off"
                    value={value}
                    onChange={(event) => setExample(index, event.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div>
        <label htmlFor="template-footer" className={LABEL}>
          Footer · optional
        </label>
        <Input
          id="template-footer"
          autoComplete="off"
          value={draft.footer}
          onChange={(event) => onChange({ ...draft, footer: event.target.value })}
          placeholder="Powered by Eccos"
          aria-invalid={footerBlocked}
        />
        <p className={HELP}>Static text under the body. No variables.</p>
        {footerBlocked && !footer.ok ? <p className={ERROR}>{footer.reason}</p> : null}
      </div>

      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className={LABEL}>Buttons · up to {MAX_CREATE_BUTTONS} links</legend>
        {draft.buttons.map((button, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional by definition; the inputs are controlled
          <div key={index} className="flex flex-col gap-2">
            <div className={BUTTON_ROW}>
              <Input
                aria-label={`Button ${index + 1} label`}
                autoComplete="off"
                value={button.text}
                placeholder="Label"
                onChange={(event) => setButton(index, { text: event.target.value })}
              />
              <Input
                aria-label={`Button ${index + 1} URL`}
                autoComplete="off"
                value={button.url}
                placeholder="https://example.com/…"
                onChange={(event) => setButton(index, { url: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-none"
                aria-label={`Remove button ${index + 1}`}
                onClick={() => onChange({ ...draft, buttons: draft.buttons.filter((_, i) => i !== index) })}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </div>
            {isDynamicUrl(button.url) ? (
              <div className={BUTTON_ROW}>
                <label htmlFor={`template-button-${index}-example`} className={`justify-self-end ${MACHINE_CLASS}`}>
                  {"Example {{1}}"}
                </label>
                <Input
                  id={`template-button-${index}-example`}
                  autoComplete="off"
                  value={button.example}
                  placeholder="4821"
                  onChange={(event) => setButton(index, { example: event.target.value })}
                />
              </div>
            ) : null}
          </div>
        ))}
        {!buttons.ok ? <p className={ERROR}>{buttons.reason}</p> : null}
        {draft.buttons.length < MAX_CREATE_BUTTONS ? (
          <button
            type="button"
            onClick={() => onChange({ ...draft, buttons: [...draft.buttons, { text: "", url: "", example: "" }] })}
            className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            + Add button
          </button>
        ) : null}
      </fieldset>

      <p className="m-0 max-w-prose text-xs text-pretty text-muted-foreground">
        {"The console creates text templates: a body with positional variables ({{1}}, {{2}}…), an optional footer, and up to three URL buttons. "}
        {"For media headers, carousels, authentication templates, or quick-reply buttons, use "}
        <a href={managerUrl(wabaId)} target="_blank" rel="noreferrer" className="underline underline-offset-4">
          WhatsApp Manager
        </a>
        .
      </p>
    </div>
  );
}

/** A field's value as the form would hold it, greyed and not editable. */
function Shown({ label, value, tall = false }: { label?: string; value: string; tall?: boolean }) {
  return (
    <div className="min-w-0">
      {label ? <p className={LABEL}>{label}</p> : null}
      <p
        className={`m-0 border border-(--line) bg-muted px-3 py-2 text-sm text-pretty whitespace-pre-wrap break-words text-foreground ${tall ? "min-h-16" : ""}`}
      >
        {value || "—"}
      </p>
    </div>
  );
}

/** A language the console cannot edit right now, laid out as the form would show it. */
export function LanguageReadOnly({ content }: { content: ReadOnlyContent }) {
  return (
    <div className="flex flex-col gap-6">
      {content.header ? <Shown label="Header" value={content.header} /> : null}
      <div>
        <Shown label="Body" value={content.body} tall />
        {content.examples.length > 0 ? (
          <div className="mt-3 flex flex-col gap-3 border-l border-(--line) pl-4">
            <p className="m-0 text-xs text-muted-foreground">Sample values for Meta's reviewers. Never sent to anyone.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {content.examples.map(([key, value]) => (
                <Shown key={key} label={`Example ${key}`} value={value} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {content.footer ? (
        <div>
          <Shown label="Footer" value={content.footer} />
          <p className={HELP}>Static text under the body. No variables.</p>
        </div>
      ) : null}
      {content.buttons.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className={LABEL}>Buttons</p>
          {content.buttons.map((button, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional by definition
            <div key={index} className="flex flex-col gap-2">
              <div className={BUTTON_ROW}>
                <Shown value={button.text} />
                <Shown value={button.target} />
              </div>
              {button.example ? (
                <div className={BUTTON_ROW}>
                  <span className={`justify-self-end ${MACHINE_CLASS}`}>{"Example {{1}}"}</span>
                  <Shown value={button.example} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
