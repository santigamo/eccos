import { isBsuid } from "@eccos/core/bsuid";
import type { TemplateHeaderMedia } from "@eccos/gateway-contract";
import { z } from "zod";
// The console's own template rules (pure, shared with its forms), imported so an agent gets the
// rules a person gets. They belong in a shared package; see the 1.9 report.
import {
  MAX_BODY_PARAMS,
  MAX_BUTTON_TEXT_LENGTH,
  MAX_CREATE_BUTTONS,
  MAX_FOOTER_LENGTH,
  type TemplateListRow,
  analyzeDraftBody,
  analyzeDraftButtons,
  analyzeDraftFooter,
  analyzeTemplate,
  canSendTemplate,
  templateRowsOf,
} from "../../../dashboard/src/lib/template-params";
import { ToolError, defineTool } from "./registry";
import { pointer, resolvePhone, resolveWaba } from "./scope";

/** The console validator's shapes (apps/dashboard/src/server/gateway.ts). */
const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const TEMPLATE_ID_PATTERN = /^[0-9]{1,32}$/;
const WABA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PHONE_NUMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RECIPIENT_PATTERN = /^[0-9]{5,15}$/;
const MAX_PARAM_LENGTH = 1024;
const MAX_HEADER_LINK_LENGTH = 2048;
const LIST_LIMIT = 100;

const wabaId = z
  .string()
  .regex(WABA_ID_PATTERN)
  .optional()
  .describe(
    'WhatsApp Business account (WABA) id, e.g. "102290129340398". Omit it when the workspace has exactly one; numbers_list lists them.',
  );
const templateName = z
  .string()
  .regex(TEMPLATE_NAME_PATTERN)
  .describe(
    'Template name: lowercase letters, digits and underscores, e.g. "order_update". A name is unique per language.',
  );
const language = z
  .string()
  .regex(LANGUAGE_PATTERN)
  .describe('Language code as Meta writes it, e.g. "en_US", "es", "pt_BR".');
const templateId = z
  .string()
  .regex(TEMPLATE_ID_PATTERN)
  .describe(
    'Meta\'s id of one translation of the template, digits only, e.g. "1234567890123456". templates_list returns it as id.',
  );
const category = z
  .enum(["MARKETING", "UTILITY"])
  .describe(
    "UTILITY for messages about something the customer already started (an order, a booking, an account); MARKETING for anything promotional. Meta may assign another category; the result says which. Authentication templates cannot be authored here.",
  );

const content = {
  bodyText: z
    .string()
    .min(1)
    .max(1024)
    .describe(
      'The message body, 1 to 1024 characters. Variables are positional, numbered from {{1}} without gaps, e.g. "Hi {{1}}, your order {{2}} has shipped." Named variables like {{name}} are refused. Starting or ending with a variable is a common reason Meta rejects a template.',
    ),
  bodyExamples: z
    .array(z.string().max(MAX_PARAM_LENGTH))
    .max(MAX_BODY_PARAMS)
    .optional()
    .describe(
      'One realistic example value per variable, in order, e.g. ["Ana", "A-1042"]. Required when the body has variables: Meta\'s reviewers read them. One line each.',
    ),
  footerText: z
    .string()
    .max(MAX_FOOTER_LENGTH)
    .optional()
    .describe(
      `Optional static footer under the body, one line of at most ${MAX_FOOTER_LENGTH} characters without variables, e.g. "Reply STOP to unsubscribe".`,
    ),
  buttons: z
    .array(
      z.object({
        text: z
          .string()
          .max(MAX_BUTTON_TEXT_LENGTH)
          .describe(
            `Button label, at most ${MAX_BUTTON_TEXT_LENGTH} characters, e.g. "Track order".`,
          ),
        url: z
          .string()
          .describe(
            'https URL the button opens. One {{1}} at the end makes it dynamic, filled at send time, e.g. "https://shop.example/track/{{1}}".',
          ),
        exampleUrl: z
          .string()
          .optional()
          .describe(
            'Required for a dynamic URL and refused for a static one: the URL with an example filled in, e.g. "https://shop.example/track/A-1042".',
          ),
      }),
    )
    .max(MAX_CREATE_BUTTONS)
    .optional()
    .describe(
      `Up to ${MAX_CREATE_BUTTONS} link buttons, in order. Quick replies, phone, copy-code and OTP buttons cannot be authored here.`,
    ),
};

type Content = {
  bodyText: string;
  bodyExamples?: string[];
  footerText?: string;
  buttons?: { text: string; url: string; exampleUrl?: string }[];
};

const fix = (reason: string, tool: string) =>
  new ToolError(`${reason} Fix it and call ${tool} again.`);

/** The console validator's content rules (`templateContentOf`), on top of its pure analyses. */
function templateContent(input: Content, tool: string): Content {
  const draft = analyzeDraftBody(input.bodyText);
  if (!draft.ok) throw fix(draft.reason, tool);
  const examples = (input.bodyExamples ?? []).map((value) => value.trim());
  if (examples.length !== draft.paramCount) {
    throw fix(
      `This body has ${draft.paramCount} variable(s), so bodyExamples needs exactly ${draft.paramCount} value(s); it has ${examples.length}.`,
      tool,
    );
  }
  if (examples.some((value) => !value))
    throw fix("Every variable needs a non-empty example value.", tool);
  if (examples.some((value) => /[\n\t]/.test(value)))
    throw fix("Example values cannot contain line breaks or tabs.", tool);

  const footerText = input.footerText?.trim();
  if (footerText !== undefined) {
    if (!footerText)
      throw fix("footerText cannot be empty; omit it for no footer.", tool);
    const footer = analyzeDraftFooter(footerText);
    if (!footer.ok) throw fix(footer.reason, tool);
  }

  const buttons = (input.buttons ?? []).map((button) => ({
    text: button.text.trim(),
    url: button.url.trim(),
    exampleUrl: button.exampleUrl?.trim() ?? "",
  }));
  const drafted = analyzeDraftButtons(buttons);
  if (!drafted.ok) throw fix(drafted.reason, tool);
  for (const [index, button] of buttons.entries()) {
    if (/[\n\t]/.test(button.url))
      throw fix(`Button ${index + 1}'s URL must be one line.`, tool);
    const dynamic = button.url.includes("{{");
    if (dynamic && !/^https?:\/\//.test(button.exampleUrl))
      throw fix(
        `Button ${index + 1}'s exampleUrl must start with https://.`,
        tool,
      );
    if (!dynamic && button.exampleUrl)
      throw fix(
        `Button ${index + 1} has a static URL, so it carries no exampleUrl; remove it.`,
        tool,
      );
  }

  return {
    bodyText: input.bodyText,
    ...(examples.length > 0 ? { bodyExamples: examples } : {}),
    ...(footerText !== undefined ? { footerText } : {}),
    ...(buttons.length > 0
      ? {
          buttons: buttons.map(({ text, url, exampleUrl }) => ({
            text,
            url,
            ...(url.includes("{{") ? { exampleUrl } : {}),
          })),
        }
      : {}),
  };
}

const RATE_LIMITED_AT_META = (tool: string) =>
  new ToolError(
    `Meta is rate-limiting template changes for this WhatsApp Business account. Wait a few minutes before calling ${tool} again; do not retry in a loop.`,
    "rate_limited",
  );

const metaSaid = (detail: string | null) =>
  detail ? ` Meta said: "${detail}"` : "";

// --- templates_list ---------------------------------------------------------------------------

const testSend = z.union([
  z.object({
    ready: z.literal(true),
    bodyParamCount: z
      .number()
      .int()
      .describe("How many bodyParams template_send_test needs."),
    buttonParams: z
      .array(z.object({ index: z.number().int(), urlPrefix: z.string() }))
      .describe(
        "One buttonParams entry template_send_test needs per dynamic URL button: index, and the URL its text completes.",
      ),
    headerMedia: z
      .enum(["image", "video", "document"])
      .nullable()
      .describe(
        "When set, template_send_test needs headerMedia with this format and an https link.",
      ),
  }),
  z.object({ ready: z.literal(false), reason: z.string() }),
]);

const templateRow = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  status: z
    .string()
    .describe(
      "Meta's review status: APPROVED, PENDING, REJECTED, PAUSED, DISABLED…",
    ),
  category: z.string(),
  rejectedReason: z
    .string()
    .nullable()
    .describe(
      "Meta's reason code for a rejection, e.g. INVALID_FORMAT; null otherwise.",
    ),
  quality: z
    .string()
    .nullable()
    .describe(
      "Meta's quality rating: GREEN, YELLOW, RED or UNKNOWN; null when absent.",
    ),
  components: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      "Meta's components (HEADER, BODY, FOOTER, BUTTONS) as Meta returns them.",
    ),
  testSend: testSend.describe(
    "Whether template_send_test can send this template, and what it needs.",
  ),
});

const str = (value: unknown) => (typeof value === "string" ? value : "");

function testSendOf(row: TemplateListRow): z.input<typeof testSend> {
  if (!canSendTemplate(row.status)) {
    return {
      ready: false,
      reason: `Its status is ${str(row.status) || "unknown"}; only an APPROVED template can be sent.`,
    };
  }
  const analysis = analyzeTemplate(row);
  if (analysis.kind === "unsupported")
    return { ready: false, reason: analysis.reason };
  return {
    ready: true,
    bodyParamCount: analysis.paramCount,
    buttonParams: analysis.buttons,
    headerMedia: analysis.headerMedia,
  };
}

type Row = TemplateListRow & {
  rejected_reason?: unknown;
  quality_score?: { score?: unknown };
};

function rowOf(row: Row): z.input<typeof templateRow> {
  const rejected = str(row.rejected_reason).toUpperCase();
  return {
    id: str(row.id),
    name: str(row.name),
    language: str(row.language),
    status: str(row.status).toUpperCase(),
    category: str(row.category).toUpperCase(),
    rejectedReason: rejected && rejected !== "NONE" ? rejected : null,
    quality: str(row.quality_score?.score).toUpperCase() || null,
    components: Array.isArray(row.components)
      ? (row.components as Record<string, unknown>[])
      : [],
    testSend: testSendOf(row),
  };
}

const graphMessage = (error: unknown): string | null => {
  const inner = (error as { error?: { message?: unknown } } | null)?.error;
  if (typeof inner?.message === "string" && inner.message.trim())
    return inner.message.trim();
  return typeof error === "string" && error.trim() ? error.trim() : null;
};

export const templatesList = defineTool({
  name: "templates_list",
  action: "view",
  stepUp: false,
  title: "List message templates",
  description: [
    "Lists the WhatsApp message templates of one WhatsApp Business account, as Meta reports them: id, name, language, review status, category,",
    "rejection reason, quality rating and components. For each one, testSend says whether template_send_test can send it and exactly which",
    "bodyParams, buttonParams and headerMedia it needs. Use it to check whether a template Meta is reviewing has been APPROVED, to read a template",
    "before template_edit, and to get the id template_edit and template_delete need. Filter with status or name to keep the answer short. Changes nothing.",
  ].join(" "),
  inputSchema: z.object({
    wabaId,
    status: z
      .enum([
        "APPROVED",
        "PENDING",
        "REJECTED",
        "PAUSED",
        "DISABLED",
        "IN_APPEAL",
        "LIMIT_EXCEEDED",
      ])
      .optional()
      .describe(
        'Only templates with this review status, e.g. "APPROVED" for the ones that can be sent.',
      ),
    name: z
      .string()
      .max(512)
      .optional()
      .describe('Only templates whose name contains this text, e.g. "order".'),
  }),
  outputSchema: z.object({
    wabaId: z.string(),
    templates: z.array(templateRow),
    truncated: z
      .boolean()
      .describe(
        `True when the account has more than the first ${LIST_LIMIT} templates Meta returned, so some are missing from this list.`,
      ),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async (input, actor, deps) => {
    const { gateway } = deps.for("view");
    const point = pointer(deps);
    const waba = await resolveWaba(deps, point, actor.accountId, {
      wabaId: input.wabaId,
      mode: "any",
    });
    const result = await gateway.listTemplates(
      waba.wabaId,
      LIST_LIMIT,
      actor.accountId,
    );
    if (!result.ok) {
      throw new ToolError(
        `Meta did not return the templates of WABA "${waba.wabaId}".${metaSaid(graphMessage(result.error))} Try again in a minute. ${point("numbers_list", "If Meta says the access token is invalid or expired, call numbers_list to check the number's token.")}`,
      );
    }
    const rows = templateRowsOf(result.data) as Row[];
    const name = input.name?.trim().toLowerCase();
    const templates = rows
      .map(rowOf)
      .filter((row) => (input.status ? row.status === input.status : true))
      .filter((row) => (name ? row.name.includes(name) : true));
    return {
      wabaId: waba.wabaId,
      templates,
      truncated: rows.length >= LIST_LIMIT,
    };
  },
});

// --- template_create --------------------------------------------------------------------------

export const templateCreate = defineTool({
  name: "template_create",
  action: "configure",
  stepUp: false,
  title: "Create a message template",
  description: [
    "Submits a new text message template to Meta for review on one WhatsApp Business account: a body with positional variables, an optional footer and",
    "up to three link buttons. Businesses need an APPROVED template to message a customer first or after 24 hours of silence. Meta reviews it, usually",
    "within minutes and at most 24 hours: call templates_list with its name until status is APPROVED (or REJECTED, with rejectedReason), then",
    "template_send_test. Meta may assign a different category than requested; the result says so. Media headers, quick replies and authentication",
    "templates cannot be created here.",
  ].join(" "),
  inputSchema: z.object({
    wabaId,
    name: templateName,
    language,
    category,
    ...content,
  }),
  outputSchema: z.object({
    wabaId: z.string(),
    templateId: z.string(),
    name: z.string(),
    language: z.string(),
    status: z.string().describe("Meta's review status, normally PENDING."),
    category: z.string().describe("The category Meta assigned."),
    categoryChanged: z
      .boolean()
      .describe(
        "True when Meta assigned another category than the one requested.",
      ),
    next: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  audit: (input) => ({
    wabaId: input.wabaId ?? null,
    template: input.name,
    language: input.language,
    category: input.category,
  }),
  run: async (input, actor, deps) => {
    const { gateway } = deps.for("configure");
    const point = pointer(deps);
    const body = templateContent(input, "template_create");
    const waba = await resolveWaba(deps, point, actor.accountId, {
      wabaId: input.wabaId,
      mode: "any",
    });
    const result = await gateway.createTemplate(
      {
        wabaId: waba.wabaId,
        name: input.name,
        language: input.language,
        category: input.category,
        ...body,
      },
      actor.accountId,
    );
    if (!result.ok) {
      switch (result.code) {
        case "name_taken":
          throw new ToolError(
            `A template named "${input.name}" already exists in ${input.language} on WABA "${waba.wabaId}", or was deleted less than 30 days ago (Meta locks the name). Pick another name. ${point("templates_list", `To change the existing one, call templates_list with name "${input.name}" and use template_edit.`)}`,
            result.code,
          );
        case "invalid":
          throw new ToolError(
            `Meta refused the template's content.${metaSaid(result.detail)} Fix it and call template_create again.`,
            result.code,
          );
        case "rate_limited":
          throw RATE_LIMITED_AT_META("template_create");
        default:
          throw new ToolError(
            `Meta refused the template.${metaSaid(result.detail)} Tell the person if it is not something you can fix.`,
            result.code,
          );
      }
    }
    return {
      wabaId: waba.wabaId,
      templateId: result.id,
      name: input.name,
      language: input.language,
      status: result.status,
      category: result.category,
      categoryChanged: result.category !== input.category,
      next: `Meta is reviewing it. ${point("templates_list", `Call templates_list with name "${input.name}" until its status is APPROVED.`)}${deps.can("send") ? " Then call template_send_test." : ""}`,
    };
  },
});

// --- template_edit ----------------------------------------------------------------------------

export const templateEdit = defineTool({
  name: "template_edit",
  action: "configure",
  stepUp: false,
  title: "Edit a message template",
  description: [
    "Replaces the content (body, examples, footer, buttons) of one translation of a template, named by its id, name and language from templates_list,",
    "which cannot change. Send the whole new content: anything left out is removed. Only APPROVED, REJECTED or PAUSED templates can be edited, an",
    "APPROVED template keeps its category, and Meta limits how often an approved template can be edited. The edit goes back to Meta's review: call",
    "templates_list until status is APPROVED again. Use it to fix a REJECTED template instead of creating a new name.",
  ].join(" "),
  inputSchema: z.object({
    wabaId,
    templateId,
    name: templateName.describe(
      "The template's current name; it cannot change.",
    ),
    language: language.describe(
      "The translation's language; it cannot change.",
    ),
    category: category
      .optional()
      .describe(
        "Omit to keep the category. Meta refuses a category change on an APPROVED template.",
      ),
    ...content,
  }),
  outputSchema: z.object({
    wabaId: z.string(),
    templateId: z.string(),
    name: z.string(),
    language: z.string(),
    next: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  audit: (input) => ({
    wabaId: input.wabaId ?? null,
    template: input.name,
    language: input.language,
    templateId: input.templateId,
  }),
  run: async (input, actor, deps) => {
    const { gateway } = deps.for("configure");
    const point = pointer(deps);
    const body = templateContent(input, "template_edit");
    const waba = await resolveWaba(deps, point, actor.accountId, {
      wabaId: input.wabaId,
      mode: "any",
    });
    const result = await gateway.editTemplate(
      {
        wabaId: waba.wabaId,
        templateId: input.templateId,
        name: input.name,
        language: input.language,
        ...(input.category ? { category: input.category } : {}),
        ...body,
      },
      actor.accountId,
    );
    if (!result.ok) {
      switch (result.code) {
        case "not_found":
          throw new ToolError(
            `WABA "${waba.wabaId}" has no template with id "${input.templateId}" named "${input.name}" in ${input.language}. ${point("templates_list", "Call templates_list and pass the id, name and language of one row.")}`,
            result.code,
          );
        case "invalid":
          throw new ToolError(
            `Meta refused the edit: either the content breaks its format rules, or the template cannot be edited in its current status (only APPROVED, REJECTED or PAUSED can be, and an APPROVED one keeps its category).${metaSaid(result.detail)}`,
            result.code,
          );
        case "rate_limited":
          throw RATE_LIMITED_AT_META("template_edit");
        default:
          throw new ToolError(
            `Meta refused the edit.${metaSaid(result.detail)} Meta limits how often an approved template can be edited; if that is the reason, try again tomorrow.`,
            result.code,
          );
      }
    }
    return {
      wabaId: waba.wabaId,
      templateId: input.templateId,
      name: input.name,
      language: input.language,
      next: `Meta reviews the new content. ${point("templates_list", `Call templates_list with name "${input.name}" until its status is APPROVED.`)}`,
    };
  },
});

// --- template_delete --------------------------------------------------------------------------

export const templateDelete = defineTool({
  name: "template_delete",
  action: "configure",
  stepUp: false,
  title: "Delete a message template",
  description: [
    "Deletes one translation of a template at Meta, named by its id and name from templates_list; the template's other languages stay. It cannot be",
    "undone: sends that use it start failing, and Meta blocks the name for that language for 30 days. Confirm with the person before calling it.",
    "To fix a template, use template_edit instead.",
  ].join(" "),
  inputSchema: z.object({
    wabaId,
    templateId,
    name: templateName.describe(
      "The template's name, as templates_list shows it.",
    ),
  }),
  outputSchema: z.object({
    wabaId: z.string(),
    templateId: z.string(),
    name: z.string(),
    deleted: z.literal(true),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  audit: (input) => ({
    wabaId: input.wabaId ?? null,
    template: input.name,
    templateId: input.templateId,
  }),
  run: async (input, actor, deps) => {
    const { gateway } = deps.for("configure");
    const point = pointer(deps);
    const waba = await resolveWaba(deps, point, actor.accountId, {
      wabaId: input.wabaId,
      mode: "any",
    });
    const result = await gateway.deleteTemplate(
      { wabaId: waba.wabaId, name: input.name, templateId: input.templateId },
      actor.accountId,
    );
    if (!result.ok) {
      throw new ToolError(
        `Meta did not delete template "${input.name}" (id "${input.templateId}") on WABA "${waba.wabaId}".${metaSaid(result.detail)} ${point("templates_list", "Call templates_list to check that the id and name belong to the same row.")}`,
        result.code,
      );
    }
    return {
      wabaId: waba.wabaId,
      templateId: input.templateId,
      name: input.name,
      deleted: true as const,
    };
  },
});

// --- template_send_test -----------------------------------------------------------------------

/** The console's `validateRecipient`: a BSUID verbatim, or a pasted number reduced to digits. */
function recipient(value: string): string {
  if (isBsuid(value.trim())) return value.trim();
  const to = value.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!RECIPIENT_PATTERN.test(to)) {
    throw new ToolError(
      'to must be a phone number in international format, 5 to 15 digits with the country code, e.g. "+34 600 000 011", or a BSUID such as "US.13491208655302741918".',
    );
  }
  return to;
}

const oneLine = (values: string[], what: string) => {
  const trimmed = values.map((value) => value.trim());
  if (trimmed.some((value) => !value))
    throw new ToolError(`Every ${what} needs a non-empty value.`);
  if (trimmed.some((value) => /[\n\t]/.test(value)))
    throw new ToolError(
      `${what} values cannot contain line breaks or tabs; Meta refuses them.`,
    );
  return trimmed;
};

function headerMediaOf(
  media: { format: TemplateHeaderMedia["format"]; link: string } | undefined,
): TemplateHeaderMedia | undefined {
  if (!media) return undefined;
  const link = media.link.trim();
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ToolError(
      "headerMedia.link must be a full https:// URL to the file.",
    );
  }
  if (url.protocol !== "https:")
    throw new ToolError("headerMedia.link must start with https://.");
  if (url.username || url.password)
    throw new ToolError(
      "headerMedia.link must not carry a user name or password.",
    );
  return { format: media.format, link };
}

/** Why the send cannot match the approved template, checked with the console's own analysis before any money is spent. */
function mismatch(
  ready: Extract<z.input<typeof testSend>, { ready: true }>,
  body: string[],
  buttons: { index: number }[],
  media: TemplateHeaderMedia | undefined,
) {
  if (body.length !== ready.bodyParamCount)
    return `it takes exactly ${ready.bodyParamCount} bodyParams and ${body.length} were given`;
  const slots = ready.buttonParams
    .map((slot) => slot.index)
    .sort()
    .join(",");
  if (
    buttons
      .map((button) => button.index)
      .sort()
      .join(",") !== slots
  ) {
    return ready.buttonParams.length === 0
      ? "it has no dynamic URL button, so it takes no buttonParams"
      : `it takes one buttonParams entry for each dynamic URL button, at index ${slots}`;
  }
  if (ready.headerMedia === null && media)
    return "its header carries no media, so it takes no headerMedia";
  if (ready.headerMedia !== null && media?.format !== ready.headerMedia)
    return `its header is ${ready.headerMedia === "image" ? "an image" : `a ${ready.headerMedia}`}, so it needs headerMedia with format "${ready.headerMedia}" and an https link`;
  return null;
}

export const templateSendTest = defineTool({
  name: "template_send_test",
  action: "send",
  stepUp: false,
  title: "Send a template to one recipient",
  description: [
    "Sends one APPROVED template as a real WhatsApp message to one person, to check a template or the setup end to end. It reaches a real phone",
    "and Meta charges the business for it, so send only to a number the person gave you for testing, and confirm before sending. Check the template",
    "with templates_list first: its testSend field says how many bodyParams, which buttonParams and whether headerMedia it needs. Pass an",
    "idempotencyKey (a new UUID per message) and reuse it on a retry so a retry never sends twice. Sends share the workspace's rate limit with the",
    "API. Success means Meta accepted the message; delivery and read receipts arrive as status events at the subscriber URL set with webhook_set.",
  ].join(" "),
  inputSchema: z.object({
    wabaId,
    phoneNumberId: z
      .string()
      .regex(PHONE_NUMBER_ID_PATTERN)
      .optional()
      .describe(
        'The phone number id the message is sent from, e.g. "106540352242922" (numbers_list lists them). Omit it when the WABA has exactly one.',
      ),
    to: z
      .string()
      .max(160)
      .describe(
        'Recipient in international format with the country code, e.g. "+34 600 000 011" (spaces, dashes and + are fine), or a BSUID such as "US.13491208655302741918".',
      ),
    templateName: templateName.describe(
      'Name of an APPROVED template, e.g. "order_update".',
    ),
    languageCode: language.describe(
      'Language of the approved translation, e.g. "en_US".',
    ),
    bodyParams: z
      .array(z.string().max(MAX_PARAM_LENGTH))
      .max(MAX_BODY_PARAMS)
      .optional()
      .describe(
        'Values for {{1}}..{{n}} in the body, in order, one line each, e.g. ["Ana", "A-1042"]. Exactly testSend.bodyParamCount of them.',
      ),
    buttonParams: z
      .array(
        z.object({
          index: z.number().int().min(0).max(9),
          text: z.string().max(MAX_PARAM_LENGTH),
        }),
      )
      .max(3)
      .optional()
      .describe(
        'One per dynamic URL button, from testSend.buttonParams: the button\'s index and the text that completes its URL, e.g. [{ "index": 0, "text": "A-1042" }].',
      ),
    headerMedia: z
      .object({
        format: z.enum(["image", "video", "document"]),
        link: z.string().max(MAX_HEADER_LINK_LENGTH),
      })
      .optional()
      .describe(
        'Only for a template whose header is media (testSend.headerMedia): the format and a public https link Meta downloads, e.g. { "format": "image", "link": "https://cdn.example/banner.jpg" }.',
      ),
    idempotencyKey: z
      .string()
      .uuid()
      .optional()
      .describe(
        "A UUID you generate once per intended message. Retrying with the same key never sends twice; a new message needs a new key.",
      ),
  }),
  outputSchema: z.object({
    status: z.literal("accepted"),
    messageId: z
      .string()
      .describe(
        "Meta's message id (wamid), which status events at the subscriber refer to.",
      ),
    wabaId: z.string(),
    phoneNumberId: z.string(),
    templateName: z.string(),
    languageCode: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  audit: (input) => ({
    wabaId: input.wabaId ?? null,
    phoneNumberId: input.phoneNumberId ?? null,
    template: input.templateName,
    language: input.languageCode,
  }),
  run: async (input, actor, deps) => {
    const { gateway } = deps.for("send");
    const point = pointer(deps);
    const to = recipient(input.to);
    const bodyParams = oneLine(input.bodyParams ?? [], "bodyParams");
    const buttonTexts = oneLine(
      (input.buttonParams ?? []).map((button) => button.text),
      "buttonParams text",
    );
    const buttonParams = (input.buttonParams ?? []).map((button, i) => ({
      index: button.index,
      text: buttonTexts[i] ?? "",
    }));
    const headerMedia = headerMediaOf(input.headerMedia);
    const waba = await resolveWaba(deps, point, actor.accountId, {
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      mode: "active",
    });
    const phoneNumberId = resolvePhone(waba, point, input.phoneNumberId);

    const listed = await deps
      .for("view")
      .gateway.listTemplates(waba.wabaId, LIST_LIMIT, actor.accountId);
    if (listed.ok) {
      const rows = templateRowsOf(listed.data);
      const row = rows.find(
        (candidate) =>
          candidate.name === input.templateName &&
          candidate.language === input.languageCode,
      );
      if (!row && rows.length < LIST_LIMIT) {
        throw new ToolError(
          `WABA "${waba.wabaId}" has no template "${input.templateName}" in ${input.languageCode}. Nothing was sent. ${point("templates_list", "Call templates_list to see its templates and languages.")}`,
        );
      }
      if (row) {
        const ready = testSendOf(row);
        if (!ready.ready)
          throw new ToolError(
            `Template "${input.templateName}" (${input.languageCode}) cannot be sent from here: ${ready.reason} Nothing was sent.`,
          );
        const wrong = mismatch(ready, bodyParams, buttonParams, headerMedia);
        if (wrong)
          throw new ToolError(
            `Template "${input.templateName}" (${input.languageCode}) does not match: ${wrong}. Nothing was sent; fix the arguments and call template_send_test again.`,
          );
      }
    }

    const result = await gateway.sendTemplateTest(
      {
        wabaId: waba.wabaId,
        phoneNumberId,
        to,
        templateName: input.templateName,
        languageCode: input.languageCode,
        ...(bodyParams.length > 0 ? { bodyParams } : {}),
        ...(buttonParams.length > 0 ? { buttonParams } : {}),
        ...(headerMedia ? { headerMedia } : {}),
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
      actor.accountId,
    );
    if (result.ok) {
      return {
        status: "accepted" as const,
        messageId: result.messageId,
        wabaId: waba.wabaId,
        phoneNumberId,
        templateName: input.templateName,
        languageCode: input.languageCode,
      };
    }
    const retrySafely = input.idempotencyKey
      ? "Retry later with the same idempotencyKey, which never sends twice."
      : "Do not send again until the person confirms it did not arrive; next time pass an idempotencyKey so a retry is safe.";
    const message: Record<typeof result.code, string> = {
      rate_limited:
        "Nothing was sent: this WhatsApp Business account reached its Eccos send rate limit, which it shares with the API and the console. Wait a minute before sending again, and do not retry in a loop.",
      no_phone: `Nothing was sent: phone number id "${phoneNumberId}" is no longer registered on WABA "${waba.wabaId}". ${point("numbers_list", "Call numbers_list to see its phones.")}`,
      recipient_not_allowlisted:
        "Nothing was sent: Meta refused the recipient because this is a Cloud API test number, which only sends to numbers on its allowed list. Ask the person to add the recipient in Meta's WhatsApp Manager (API Setup) or to use a production number.",
      template_not_found: `Nothing was sent: Meta has no approved translation of "${input.templateName}" in ${input.languageCode}. ${point("templates_list", "Call templates_list to check its status and languages.")}`,
      parameter_mismatch: `Nothing was sent: Meta expected different parameters for "${input.templateName}". ${point("templates_list", "Call templates_list and pass what its testSend field asks for.")}`,
      in_progress:
        "Nothing was sent now: an earlier send with this idempotencyKey has not settled, or its outcome is unknown, so it may already have been sent. Ask the person whether it arrived before sending again with a new key.",
      unknown: `Meta did not confirm this send, so it may already have been sent. ${retrySafely}`,
      key_reused:
        "Nothing was sent: this idempotencyKey was already used for a different message. Use a new UUID for a new message.",
      graph: `Meta refused the send.${metaSaid(result.detail)} Nothing was sent; tell the person if it is not something you can fix.`,
    };
    throw new ToolError(message[result.code], result.code);
  },
});

export const TEMPLATE_TOOLS = [
  templatesList,
  templateCreate,
  templateEdit,
  templateDelete,
  templateSendTest,
] as const;
