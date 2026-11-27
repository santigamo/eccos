import type { CreateTemplateInput, EditTemplateInput } from "@eccos/gateway-contract";
import type { Result } from "../server/gateway";
import { failureCopy, type FailureCopy } from "./failure";
import { draftContent, type TemplateCategory } from "./template-draft";
import type { LanguageTab, Notice } from "./template-group";

export type TemplateRequest = { kind: "create"; data: CreateTemplateInput } | { kind: "edit"; data: EditTemplateInput };

/** The gateway call for one tab: a create for a language not at Meta, an edit carrying `templateId` otherwise. */
export function requestFor(
  tab: LanguageTab,
  shared: { wabaId: string; name: string; category: TemplateCategory },
): TemplateRequest {
  const base = { wabaId: shared.wabaId, name: shared.name, language: tab.language, ...draftContent(tab.draft) };
  if (!tab.row) return { kind: "create", data: { ...base, category: shared.category } };
  return {
    kind: "edit",
    data: { ...base, templateId: tab.row.id ?? "", ...(tab.recategorize ? { category: shared.category } : {}) },
  };
}

type Answer<C extends string> = { ok: true; category?: string } | { ok: false; code: C; detail: string | null };

/** `null` when Meta took it; otherwise why not, with Meta's sentence only where the console cannot explain. */
export function refusal<C extends string>(
  result: Result<Answer<C>>,
  copy: (code: C, detail: string | null) => FailureCopy,
): Notice | null {
  if (!result.ok) return failureCopy(result);
  if (result.data.ok) return null;
  const { code, detail } = result.data;
  return { ...copy(code, detail), ...((code === "graph" || code === "invalid") && detail ? { secondary: detail } : {}) };
}

/** The category Meta put a created language in, when it is not the one asked for. */
export function movedCategory(result: Result<Answer<string>>, requested: string): string | null {
  const category = result.ok && result.data.ok ? result.data.category?.toUpperCase() : undefined;
  return category && category !== requested ? category : null;
}

/** A send that threw instead of answering. Meta may or may not have the language. */
export const UNANSWERED: Notice = {
  title: "No answer",
  detail: "The request failed before Meta answered. Reload the template to see whether Meta has this language, then try again.",
};

/** Sends each item in order and stops at the first refusal; a throw counts as one. Nothing after it is attempted. */
export async function submitSerially<T>(
  items: T[],
  send: (item: T) => Promise<Notice | null>,
): Promise<{ done: T[]; failed: { item: T; notice: Notice } | null }> {
  const done: T[] = [];
  for (const item of items) {
    const notice = await send(item).catch(() => UNANSWERED);
    if (notice) return { done, failed: { item, notice } };
    done.push(item);
  }
  return { done, failed: null };
}

/**
 * Where a create goes next: all created, back to the list; the first refused,
 * nowhere; some created, the template's own page on the language that failed.
 * Both skip the leave guard: what they leave behind is sent or handed over.
 */
export function afterCreate(name: string, wabaId: string | undefined, created: number, failed: string | null) {
  if (!failed) return { to: "/templates", search: { wabaId }, ignoreBlocker: true } as const;
  if (created === 0) return null;
  return {
    to: "/templates/$name",
    params: { name },
    search: { wabaId, language: failed },
    replace: true,
    ignoreBlocker: true,
  } as const;
}
