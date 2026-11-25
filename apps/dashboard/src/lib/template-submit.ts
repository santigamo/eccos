/**
 * Sending a template's languages to Meta: one gateway call per language, one
 * after another, stopping at the first refusal, and where the page goes next.
 * Type-only imports, so it runs under plain `bun test`.
 */

import type { CreateTemplateResult, EditTemplateResult, Result } from "../server/gateway";
import { createTemplateFailureCopy, editTemplateFailureCopy, failureCopy } from "./failure";
import type { Notice } from "./template-group";

/** Meta's own sentence is shown only for the codes the console cannot explain itself. */
function withSecondary(code: string, detail: string | null): Pick<Notice, "secondary"> {
  return (code === "graph" || code === "invalid") && detail ? { secondary: detail } : {};
}

/** `null` when Meta created it; otherwise why not, in the console's words. */
export function createFailure(result: Result<CreateTemplateResult>): Notice | null {
  if (!result.ok) return failureCopy(result);
  if (result.data.ok) return null;
  return { ...createTemplateFailureCopy(result.data.code, result.data.detail), ...withSecondary(result.data.code, result.data.detail) };
}

export function editFailure(result: Result<EditTemplateResult>): Notice | null {
  if (!result.ok) return failureCopy(result);
  if (result.data.ok) return null;
  return { ...editTemplateFailureCopy(result.data.code, result.data.detail), ...withSecondary(result.data.code, result.data.detail) };
}

export interface SerialOutcome<T> {
  done: T[];
  failed: { item: T; notice: Notice } | null;
}

/** Sends each item in order and stops at the first refusal; nothing after it is attempted. */
export async function submitSerially<T>(items: T[], send: (item: T) => Promise<Notice | null>): Promise<SerialOutcome<T>> {
  const done: T[] = [];
  for (const item of items) {
    const notice = await send(item);
    if (notice) return { done, failed: { item, notice } };
    done.push(item);
  }
  return { done, failed: null };
}

export type AfterCreate =
  | { kind: "list"; toast: { title: string; description: string } }
  | { kind: "stay" }
  | { kind: "group"; name: string; language: string };

/**
 * Where a create goes next. All created: back to the list. The first refused:
 * stay, nothing exists at Meta. Some created: the template now exists, so the
 * page becomes its edit page, on the language that failed.
 */
export function afterCreate(name: string, created: string[], failed: string | null): AfterCreate {
  if (!failed) return { kind: "list", toast: createdToast(name, created.length) };
  if (created.length === 0) return { kind: "stay" };
  return { kind: "group", name, language: failed };
}

export function createdToast(name: string, count: number): { title: string; description: string } {
  return {
    title: `${name} submitted in ${count} ${count === 1 ? "language" : "languages"}.`,
    description: "Meta reviews each one, usually within minutes.",
  };
}
