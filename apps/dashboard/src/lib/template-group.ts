/**
 * A template name as the authoring page reads it: one tab per language, what
 * each tab is (at Meta, in review, a draft), the state word it wears, and what
 * the one primary action sends. Pure, so every branch is asserted without a DOM.
 */

import {
  blankDraft,
  isDraftDirty,
  languageBlocker,
  type LanguageDraft,
  type TemplateCategory,
} from "./template-draft";
import { languageLabel } from "./template-languages";
import { authoringReading, canEditStatus, type TemplateRecord } from "./template-view";

/** A refusal in the console's words, with Meta's own sentence when it explains. */
export interface Notice {
  title: string;
  detail: string;
  secondary?: string;
}

export type TabState = "INCOMPLETE" | "EDITED" | "IN REVIEW" | "REJECTED" | "NOT CREATED";

export interface LanguageTab {
  language: string;
  draft: LanguageDraft;
  /** Meta's copy of this language, or `null` when it is not at Meta. */
  initial: LanguageDraft | null;
  row: TemplateRecord | null;
  /** Meta's status, or PENDING once this page submitted it. */
  status: string | null;
  /** Why the panel is read-only, or `null` when it can be edited. */
  readOnly: string | null;
  error: Notice | null;
  /** Holds something the operator would lose by leaving. */
  dirty: boolean;
}

export interface GroupInput {
  /** This name's rows, as the list loaded them. */
  rows: TemplateRecord[];
  /** The operator's copy of each language they touched, by code. */
  drafts: Record<string, LanguageDraft>;
  /** Languages not at Meta yet, in tab order. */
  added: string[];
  /** What an added language started from (a duplicate's source), so an untouched copy is not dirty. */
  seeds?: Record<string, LanguageDraft>;
  /** Languages this page sent to Meta, read as in review until the page is left. */
  submitted: Record<string, LanguageDraft>;
  errors: Record<string, Notice>;
  category: TemplateCategory;
  /** The category can be changed, so moving it re-submits every editable language. */
  categoryOpen?: boolean;
}

export function pendingLine(language: string): string {
  return `Meta is reviewing ${languageLabel(language)}, usually for a few minutes. It can be edited again once Meta answers.`;
}

export function buildTabs(input: GroupInput): LanguageTab[] {
  const tabs: LanguageTab[] = [];
  const seen = new Set<string>();
  for (const row of input.rows) {
    const language = row.language;
    if (!language || seen.has(language)) continue;
    seen.add(language);
    const submitted = input.submitted[language];
    const status = submitted ? "PENDING" : (row.status?.toUpperCase() ?? null);
    const reading = authoringReading(row);
    const initial = reading.ok ? withoutShared(reading.draft) : null;
    const draft = input.drafts[language] ?? submitted ?? initial ?? blankDraft(language);
    const readOnly =
      status === "PENDING"
        ? pendingLine(language)
        : !reading.ok
          ? reading.reason
          : !canEditStatus(status ?? undefined)
            ? `Meta does not allow editing a template that is ${(status ?? "unknown").toLowerCase()}.`
            : null;
    const recategorized = Boolean(input.categoryOpen) && row.category?.toUpperCase() !== input.category;
    tabs.push({
      language,
      draft,
      initial,
      row,
      status,
      readOnly,
      error: input.errors[language] ?? null,
      dirty: !readOnly && (isDraftDirty(draft, initial) || recategorized),
    });
  }
  for (const [language, draft] of Object.entries(input.submitted)) {
    if (seen.has(language)) continue;
    seen.add(language);
    tabs.push({ language, draft, initial: draft, row: null, status: "PENDING", readOnly: pendingLine(language), error: null, dirty: false });
  }
  for (const language of input.added) {
    if (seen.has(language)) continue;
    seen.add(language);
    const draft = input.drafts[language] ?? blankDraft(language);
    tabs.push({
      language,
      draft,
      initial: null,
      row: null,
      status: null,
      readOnly: null,
      error: input.errors[language] ?? null,
      dirty: isDraftDirty(draft, input.seeds?.[language] ?? null),
    });
  }
  return tabs;
}

function withoutShared({ language, body, examples, footer, buttons }: LanguageDraft): LanguageDraft {
  return { language, body, examples, footer, buttons };
}

/** The tabs the primary action sends: every language not at Meta, and every edited one. */
export function submission(tabs: LanguageTab[]): LanguageTab[] {
  return tabs.filter((tab) => !tab.readOnly && (tab.status === null || tab.dirty));
}

/** The one word a tab wears beside its language. `null` when there is nothing to say. */
export function tabState(tab: LanguageTab): TabState | null {
  if (tab.error) return "NOT CREATED";
  if (tab.status === "PENDING") return "IN REVIEW";
  const sent = !tab.readOnly && (tab.status === null || tab.dirty);
  if (sent && languageBlocker(tab.draft, "sent")) return "INCOMPLETE";
  if (tab.status === "REJECTED") return "REJECTED";
  if (tab.row && tab.dirty) return "EDITED";
  return null;
}

export const STATE_INK: Record<TabState, string> = {
  INCOMPLETE: "text-warning-foreground",
  EDITED: "text-warning-foreground",
  "IN REVIEW": "text-muted-foreground",
  REJECTED: "text-destructive-foreground",
  "NOT CREATED": "text-destructive-foreground",
};

/** "A", "A and B", "A, B and C". */
export function listLanguages(languages: string[]): string {
  const labels = languages.map(languageLabel);
  return labels.length < 2 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export type AuthoringMode = "create" | "edit";

export function primaryLabel(mode: AuthoringMode, sending: LanguageTab[], active: string): string {
  if (mode === "create") return sending.length > 1 ? `Create ${sending.length} languages` : "Create template";
  const only = sending[0];
  if (sending.length > 1) return `Submit ${sending.length} languages for review`;
  if (only?.error) return `Retry ${languageLabel(only.language)}`;
  return `Submit ${languageLabel(only?.language ?? active)} for review`;
}

/** Why the primary is off, or `null` when it is live. */
export function barBlocker(mode: AuthoringMode, name: string, sending: LanguageTab[]): string | null {
  if (mode === "create" && !name.trim()) return "Name the template before it can be created.";
  if (sending.length === 0) return "No unsent changes.";
  for (const tab of sending) {
    const reason = languageBlocker(tab.draft, tab.status === null ? "created" : "submitted");
    if (reason) return reason;
  }
  return null;
}

/** The bar's line when nothing blocks: what happened, or what is waiting to be sent. */
export function barNote(mode: AuthoringMode, sending: LanguageTab[], created: string[]): string | null {
  const failed = sending.find((tab) => tab.error);
  if (failed) {
    const label = languageLabel(failed.language);
    if (created.length === 0) return `${label} was not created.`;
    return `${listLanguages(created)} ${created.length > 1 ? "were" : "was"} created. ${label} was not.`;
  }
  if (mode === "create" || sending.length === 0) return null;
  return `${listLanguages(sending.map((tab) => tab.language))} ${sending.length > 1 ? "have" : "has"} unsent changes.`;
}

/** The category a template name's languages share: the most common one the console authors. */
export function groupCategory(rows: TemplateRecord[]): TemplateCategory {
  const marketing = rows.filter((row) => row.category?.toUpperCase() === "MARKETING").length;
  const utility = rows.filter((row) => row.category?.toUpperCase() === "UTILITY").length;
  return marketing > utility ? "MARKETING" : "UTILITY";
}

/**
 * Why the category cannot change from this page, or `null` when it can. Meta
 * refuses a new category on an approved language, one in review cannot be
 * edited at all, and a category change re-submits every language at Meta.
 */
export function categoryLock(tabs: LanguageTab[]): string | null {
  if (tabs.some((tab) => tab.status === "APPROVED")) return "Locked while a language is approved";
  if (tabs.some((tab) => tab.status === "PENDING")) return "Locked while Meta reviews a language";
  if (tabs.some((tab) => tab.status !== null && tab.readOnly)) return "Locked while a language cannot be edited";
  return null;
}

/**
 * The router blocker for a page holding unsent work: the browser's leave-page
 * warning, and a block on in-app navigation to another path. A change of
 * `?language=` is a tab switch on the same page, never a departure.
 */
export function leaveBlocker(guarded: boolean) {
  return {
    shouldBlockFn: ({ current, next }: { current: { pathname: string }; next: { pathname: string } }) =>
      guarded && current.pathname !== next.pathname,
    enableBeforeUnload: guarded,
    withResolver: true as const,
  };
}
