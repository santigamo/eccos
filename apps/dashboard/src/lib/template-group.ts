/**
 * A template name as the authoring page reads it: one tab per language, the
 * state word each wears, and what the one primary action sends.
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

/** What the page holds for one language beyond what Meta has. */
export interface LanguageState {
  /** The operator's copy, once they touched it. */
  draft?: LanguageDraft;
  /** Not at Meta when the page opened: a draft to create. */
  added?: boolean;
  /** What a duplicate started from, so an untouched copy is not dirty. */
  seed?: LanguageDraft;
  /** Sent to Meta by this page: read as in review until the page is left. */
  sent?: LanguageDraft;
  /** Meta's refusal of the last send. */
  error?: Notice;
}

export type TabState = "INCOMPLETE" | "EDITED" | "IN REVIEW" | "REJECTED" | "NOT CREATED" | "EDIT REFUSED";

export interface LanguageTab {
  language: string;
  draft: LanguageDraft;
  /** Meta's copy of this language, or `null` when it is not at Meta. */
  initial: LanguageDraft | null;
  row: TemplateRecord | null;
  /** Meta's status, or PENDING once this page sent it; `null` for a draft. */
  status: string | null;
  /** Why the panel is read-only, or `null` when it can be edited. */
  readOnly: string | null;
  error: Notice | null;
  /** Holds something the operator would lose by leaving. */
  dirty: boolean;
  /** Sending it also moves it to the page's category. */
  recategorize: boolean;
}

export interface GroupInput {
  /** This name's rows, as the list loaded them. */
  rows: TemplateRecord[];
  /** By language code, in tab order for the added ones. */
  languages: Record<string, LanguageState>;
  category: TemplateCategory;
  /** The category the page opened with: only a move away from it re-categorizes. */
  initialCategory: TemplateCategory;
}

export function pendingLine(language: string): string {
  return `Meta is reviewing ${languageLabel(language)}, usually for a few minutes. It can be edited again once Meta answers.`;
}

/** Meta takes a new category on an editable language that is not approved. */
export function categoryMovable(row: TemplateRecord): boolean {
  const status = row.status?.toUpperCase();
  return status !== "APPROVED" && canEditStatus(status) && authoringReading(row).ok;
}

/** Why no language's category can change, read from Meta's statuses, or `null` when one can. */
export function categoryLock(rows: TemplateRecord[]): string | null {
  if (rows.some(categoryMovable)) return null;
  const statuses = rows.map((row) => row.status?.toUpperCase());
  if (statuses.includes("APPROVED")) return "Locked while a language is approved";
  if (statuses.includes("PENDING")) return "Locked while Meta reviews a language";
  return "Locked while no language can be edited";
}

/** The category a template name's languages share: the most common one the console authors. */
export function groupCategory(rows: TemplateRecord[]): TemplateCategory {
  const marketing = rows.filter((row) => row.category?.toUpperCase() === "MARKETING").length;
  const utility = rows.filter((row) => row.category?.toUpperCase() === "UTILITY").length;
  return marketing > utility ? "MARKETING" : "UTILITY";
}

export function buildTabs({ rows, languages, category, initialCategory }: GroupInput): LanguageTab[] {
  const tabs: LanguageTab[] = [];
  const seen = new Set<string>();
  const moved = category !== initialCategory;
  for (const row of rows) {
    const language = row.language;
    if (!language || seen.has(language)) continue;
    seen.add(language);
    const own = languages[language] ?? {};
    const status = own.sent ? "PENDING" : (row.status?.toUpperCase() ?? null);
    const reading = authoringReading(row);
    const initial = reading.ok ? withoutShared(reading.draft) : null;
    const draft = own.draft ?? own.sent ?? initial ?? blankDraft(language);
    const readOnly =
      status === "PENDING"
        ? pendingLine(language)
        : !reading.ok
          ? reading.reason
          : !canEditStatus(status ?? undefined)
            ? `Meta does not allow editing a template that is ${(status ?? "unknown").toLowerCase()}.`
            : null;
    const recategorize = !readOnly && moved && categoryMovable(row) && row.category?.toUpperCase() !== category;
    tabs.push({
      language,
      draft,
      initial,
      row,
      status,
      readOnly,
      // In review at Meta, whatever the last send heard: a send that threw may still have landed.
      error: status === "PENDING" ? null : (own.error ?? null),
      dirty: !readOnly && (isDraftDirty(draft, initial) || recategorize),
      recategorize,
    });
  }
  for (const [language, own] of Object.entries(languages)) {
    if (seen.has(language) || !own.added) continue;
    if (own.sent) {
      const sent = own.sent;
      tabs.push({ language, draft: sent, initial: sent, row: null, status: "PENDING", readOnly: pendingLine(language), error: null, dirty: false, recategorize: false });
      continue;
    }
    const draft = own.draft ?? blankDraft(language);
    tabs.push({
      language,
      draft,
      initial: null,
      row: null,
      status: null,
      readOnly: null,
      error: own.error ?? null,
      dirty: isDraftDirty(draft, own.seed ?? null),
      recategorize: false,
    });
  }
  return tabs;
}

/**
 * The languages after a send, patched onto the latest map so nothing touched
 * meanwhile is lost: each sent language reads in review, the refused one keeps
 * its draft and the refusal.
 */
export function applySend(
  languages: Record<string, LanguageState>,
  sent: LanguageDraft[],
  failed: { language: string; notice: Notice } | null,
): Record<string, LanguageState> {
  const next = { ...languages };
  for (const draft of sent) next[draft.language] = { ...next[draft.language], sent: draft, error: undefined };
  if (failed) next[failed.language] = { ...next[failed.language], error: failed.notice };
  return next;
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
  if (tab.error) return tab.row ? "EDIT REFUSED" : "NOT CREATED";
  if (tab.status === "PENDING") return "IN REVIEW";
  const sent = !tab.readOnly && (tab.status === null || tab.dirty);
  if (sent && languageBlocker(tab.draft, "sent")) return "INCOMPLETE";
  if (tab.status === "REJECTED") return "REJECTED";
  if (tab.row && tab.dirty) return "EDITED";
  return null;
}

/** "Meta did not create Spanish." or "Meta refused the changes to Spanish." */
export function refusalLine(tab: LanguageTab): string {
  const label = languageLabel(tab.language);
  return tab.row ? `Meta refused the changes to ${label}.` : `Meta did not create ${label}.`;
}

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
    if (failed.row || created.length === 0) return refusalLine(failed);
    return `${listLanguages(created)} ${created.length > 1 ? "were" : "was"} created. ${languageLabel(failed.language)} was not.`;
  }
  if (mode === "create" || sending.length === 0) return null;
  return `${listLanguages(sending.map((tab) => tab.language))} ${sending.length > 1 ? "have" : "has"} unsent changes.`;
}
