/**
 * Compile-time drift check: `@eccos/core/template-rules` cannot import
 * `@eccos/gateway-contract`, so it restates the template types the contract
 * owns. The dashboard sees both, and `bun run typecheck` fails here the moment
 * either side changes a restated type without the other, an optional field included. Lives under `src/`
 * because the dashboard's tsconfig does not include `tests/`.
 */

import type {
  TemplateCategory,
  TemplateContent,
  TemplateDraft,
  TemplateEdit,
  TemplateHeaderMedia,
  TemplateHeaderMediaFormat,
  TemplateSendRequest,
} from "@eccos/core/template-rules";
import type * as Contract from "@eccos/gateway-contract";

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Every key required, at every depth: an optional key on one side only becomes a missing required key. */
type DeepRequired<T> = T extends (infer U)[]
  ? DeepRequired<U>[]
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<T[K]> }
    : T;
type Same<A, B> = Mutual<A, B> extends true ? Mutual<DeepRequired<A>, DeepRequired<B>> : false;

export const templateTypesMatchContract: [
  Same<TemplateHeaderMediaFormat, Contract.TemplateHeaderMediaFormat>,
  Same<TemplateHeaderMedia, Contract.TemplateHeaderMedia>,
  Same<TemplateCategory, Contract.CreateTemplateInput["category"]>,
  Same<TemplateContent, Pick<Contract.CreateTemplateInput, "bodyText" | "bodyExamples" | "footerText" | "buttons">>,
  Same<TemplateDraft, Omit<Contract.CreateTemplateInput, "wabaId">>,
  Same<TemplateEdit, Omit<Contract.EditTemplateInput, "wabaId">>,
  Same<
    TemplateSendRequest,
    Pick<Contract.SendTemplateTestInput, "templateName" | "languageCode" | "bodyParams" | "buttonParams" | "headerMedia">
  >,
] = [true, true, true, true, true, true, true];
