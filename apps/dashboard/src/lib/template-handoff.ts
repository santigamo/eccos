import type { TemplateCategory } from "./template-draft";
import type { LanguageState } from "./template-group";

/**
 * What a partly failed create hands to the template's edit page: the languages
 * Meta took (`sent`) and the drafts it did not, with the refusal. In memory and
 * keyed by name, because it lives exactly as long as the client-side navigation
 * that carries it; a reload reads the created languages back from Meta.
 */
export interface CreateHandoff {
  category: TemplateCategory;
  languages: Record<string, LanguageState>;
  /** What Meta said beyond yes or no, such as a recategorization. */
  receipt: string;
}

const handoffs = new Map<string, CreateHandoff>();

export function putHandoff(name: string, handoff: CreateHandoff): void {
  handoffs.set(name, handoff);
}

export function peekHandoff(name: string): CreateHandoff | undefined {
  return handoffs.get(name);
}

export function dropHandoff(name: string): void {
  handoffs.delete(name);
}
