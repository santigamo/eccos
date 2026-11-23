import {
  type TemplateDraft,
  type TemplateEdit,
  type TemplateSendRequest,
  validateTemplateDraft,
  validateTemplateEdit,
  validateTemplateSend,
} from "@eccos/core/template-rules";

const MAX_BUTTON_URL_LENGTH = 2000;

export const BUTTON_URL_TOO_LONG = "button url is required";
export const HEADER_LINK_WHITESPACE = "headerMedia link must not contain whitespace";

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid dashboard request");
  }
  return input as Record<string, unknown>;
}

function assertButtonUrls<T extends { buttons?: { url: string }[] }>(content: T): T {
  if (content.buttons?.some((button) => button.url.length > MAX_BUTTON_URL_LENGTH)) {
    throw new Error(BUTTON_URL_TOO_LONG);
  }
  return content;
}

export function templateDraftRequest(input: unknown): TemplateDraft {
  return assertButtonUrls(validateTemplateDraft(inputRecord(input)));
}

export function templateEditRequest(input: unknown): TemplateEdit {
  return assertButtonUrls(validateTemplateEdit(inputRecord(input)));
}

export function templateSendRequest(input: unknown): TemplateSendRequest {
  const request = validateTemplateSend(inputRecord(input));
  if (request.headerMedia && /\s/.test(request.headerMedia.link)) throw new Error(HEADER_LINK_WHITESPACE);
  return request;
}
