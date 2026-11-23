import {
  type TemplateDraft,
  type TemplateEdit,
  type TemplateSendRequest,
  validateTemplateDraft,
  validateTemplateEdit,
  validateTemplateSend,
} from "@eccos/core/template-rules";

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid dashboard request");
  }
  return input as Record<string, unknown>;
}

export function templateDraftRequest(input: unknown): TemplateDraft {
  return validateTemplateDraft(inputRecord(input));
}

export function templateEditRequest(input: unknown): TemplateEdit {
  return validateTemplateEdit(inputRecord(input));
}

export function templateSendRequest(input: unknown): TemplateSendRequest {
  return validateTemplateSend(inputRecord(input));
}
