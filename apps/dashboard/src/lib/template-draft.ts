/**
 * One language of a template as the operator types it, and the questions asked
 * of it: is anything typed, what stops it from being sent, and what request it
 * becomes. Validation stays in `@eccos/core/template-rules`, the same rules the
 * gateway enforces.
 */

import {
  analyzeDraftBody,
  analyzeDraftButtons,
  analyzeDraftFooter,
  type DraftButton,
} from "@eccos/core/template-rules";
import { languageLabel } from "./template-languages";

/** AUTHENTICATION is absent by design: those templates are preset content plus
 * OTP buttons, a different creation shape, not a missing option. */
export type TemplateCategory = "MARKETING" | "UTILITY";

export const CATEGORIES: { value: TemplateCategory; label: string }[] = [
  { value: "UTILITY", label: "Utility" },
  { value: "MARKETING", label: "Marketing" },
];

/** A URL button. For a dynamic URL `example` is only the `{{1}}` value; the
 * console builds the example URL Meta asks for from the URL template. */
export interface ButtonDraft {
  text: string;
  url: string;
  example: string;
}

export interface LanguageDraft {
  language: string;
  body: string;
  /** Example values by position. Only ever grown, which is what preserves a
   * value when its variable is removed from the body and typed back. */
  examples: string[];
  footer: string;
  buttons: ButtonDraft[];
}

/** A whole template read back from Meta: one language plus what it shares. */
export interface TemplateDraft extends LanguageDraft {
  name: string;
  category: TemplateCategory;
}

export function blankDraft(language: string): LanguageDraft {
  return { language, body: "", examples: [], footer: "", buttons: [] };
}

/** Said above an APPROVED language once it is edited, where the operator decides. */
export const APPROVED_EDIT_NOTICE =
  "This template is approved. Submitting sends it back to Meta's review, and sends with it may fail until Meta approves it again, which can take up to 24 hours. An approved template can be edited once every 24 hours and up to 10 times in 30 days. If it is in active use, duplicate it as a new template instead.";

/** A URL variable, positional or named: the one pattern that both detects and replaces it. */
const URL_VARIABLE = /\{\{[^{}]*\}\}/;

export function isDynamicUrl(url: string): boolean {
  return URL_VARIABLE.test(url);
}

/** The example URL Meta reviews, built from the URL template and its `{{1}}` value. */
export function exampleUrlFor(url: string, value: string): string {
  const trimmed = value.trim();
  return isDynamicUrl(url) && trimmed ? url.trim().replace(URL_VARIABLE, () => trimmed) : "";
}

/** The `{{1}}` value inside a stored example URL, or "" when it does not fit the template. */
export function exampleValueOf(url: string, exampleUrl: string): string {
  const [prefix = "", suffix = ""] = url.trim().split(URL_VARIABLE);
  if (!exampleUrl.startsWith(prefix) || !exampleUrl.endsWith(suffix)) return "";
  if (exampleUrl.length <= prefix.length + suffix.length) return "";
  return exampleUrl.slice(prefix.length, exampleUrl.length - suffix.length);
}

/** The buttons as core's rules and the gateway read them. */
export function coreButtons(draft: LanguageDraft): DraftButton[] {
  return draft.buttons.map((button) => ({
    text: button.text,
    url: button.url,
    exampleUrl: exampleUrlFor(button.url, button.example),
  }));
}

/**
 * The example values that belong to this draft, derived from its BODY: the
 * count comes from `analyzeDraftBody`, and a position not reached yet reads "".
 */
export function exampleValues(draft: LanguageDraft): string[] {
  const analysis = analyzeDraftBody(draft.body);
  const count = analysis.ok ? analysis.paramCount : 0;
  return Array.from({ length: count }, (_, index) => draft.examples[index] ?? "");
}

/**
 * Does this language hold anything the operator would lose?
 *
 * Against Meta's copy when there is one, comparing what would be SENT, so an
 * example kept for a variable since removed is not a change. A draft not yet at Meta is judged on
 * CONTENT, not shape: a button row added and left blank costs one click to
 * recreate, and whitespace alone is not content.
 */
export function isDraftDirty(draft: LanguageDraft, initial: LanguageDraft | null = null): boolean {
  if (initial) return JSON.stringify(draftContent(draft)) !== JSON.stringify(draftContent(initial));
  return (
    draft.body.trim() !== "" ||
    draft.footer.trim() !== "" ||
    draft.examples.some((value) => value.trim() !== "") ||
    draft.buttons.some((button) => button.text.trim() !== "" || button.url.trim() !== "" || button.example.trim() !== "")
  );
}

/** Why this language cannot be sent yet, or `null`. `verb` is "created" or "submitted". */
export function languageBlocker(draft: LanguageDraft, verb: string): string | null {
  const label = languageLabel(draft.language);
  if (!draft.body.trim()) return `${label} needs a body before it can be ${verb}.`;
  const body = analyzeDraftBody(draft.body);
  if (!body.ok) return `${label}: ${body.reason}`;
  const missing = exampleValues(draft).findIndex((value) => !value.trim());
  if (missing >= 0) return `${label} needs an example for {{${missing + 1}}}.`;
  const footer = analyzeDraftFooter(draft.footer);
  if (!footer.ok) return `${label}: ${footer.reason}`;
  const buttons = analyzeDraftButtons(coreButtons(draft));
  if (!buttons.ok) return `${label}: ${buttons.reason}`;
  return null;
}

/** The content half of a create or edit request. */
export function draftContent(draft: LanguageDraft) {
  const values = exampleValues(draft);
  const buttons = coreButtons(draft).filter((button) => button.text.trim() && button.url.trim());
  return {
    bodyText: draft.body,
    ...(values.length > 0 ? { bodyExamples: values } : {}),
    ...(draft.footer.trim() ? { footerText: draft.footer } : {}),
    ...(buttons.length > 0
      ? {
          buttons: buttons.map((button) => ({
            text: button.text,
            url: button.url,
            ...(isDynamicUrl(button.url) && button.exampleUrl ? { exampleUrl: button.exampleUrl } : {}),
          })),
        }
      : {}),
  };
}
