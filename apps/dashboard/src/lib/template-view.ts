/**
 * One Meta template row, read for display: the parts a WhatsApp preview draws,
 * the example values Meta stored with it, and the review facts the list and
 * the template sheet show. Pure, so every branch is asserted without a DOM.
 */

import type { TemplateDraft } from "../components/templates/create-template-sheet";
import { analyzeDraftBody, type TemplateListRow } from "./template-params";

export type HeaderFormat = "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";

export type TemplateHeader =
  | { format: "TEXT"; text: string }
  | { format: HeaderFormat; exampleUrl: string | null };

export type ButtonKind = "url" | "phone" | "quick_reply" | "copy_code" | "otp" | "flow" | "other";

export interface TemplateButton {
  kind: ButtonKind;
  text: string;
  url?: string;
  phone?: string;
  /** Meta's stored example for a dynamic URL. */
  exampleUrl?: string;
}

export interface TemplateView {
  header: TemplateHeader | null;
  body: string;
  footer: string;
  buttons: TemplateButton[];
  /** Meta's stored example values by placeholder key (`"1"`, or a parameter name). */
  headerExamples: Record<string, string>;
  bodyExamples: Record<string, string>;
}

interface Component {
  type?: unknown;
  format?: unknown;
  text?: unknown;
  buttons?: unknown;
  example?: {
    header_text?: unknown;
    header_handle?: unknown;
    body_text?: unknown;
    body_text_named_params?: unknown;
    header_text_named_params?: unknown;
  };
}

interface MetaButton {
  type?: unknown;
  text?: unknown;
  url?: unknown;
  phone_number?: unknown;
  example?: unknown;
}

const BUTTON_KINDS: Record<string, ButtonKind> = {
  URL: "url",
  PHONE_NUMBER: "phone",
  QUICK_REPLY: "quick_reply",
  COPY_CODE: "copy_code",
  OTP: "otp",
  FLOW: "flow",
};

const HEADER_FORMATS = new Set<string>(["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]);

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function upper(value: unknown): string {
  return str(value).toUpperCase();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function namedExamples(value: unknown, into: Record<string, string>) {
  if (!Array.isArray(value)) return;
  for (const entry of value as { param_name?: unknown; example?: unknown }[]) {
    if (typeof entry?.param_name === "string" && typeof entry.example === "string") {
      into[entry.param_name] = entry.example;
    }
  }
}

/** `null` when the row carries no components at all. */
export function templateView(row: { components?: unknown }): TemplateView | null {
  if (!Array.isArray(row.components)) return null;
  const parts = row.components as Component[];
  const find = (type: string) => parts.find((part) => upper(part?.type) === type);
  const headerExamples: Record<string, string> = {};
  const bodyExamples: Record<string, string> = {};

  const headerPart = find("HEADER");
  let header: TemplateHeader | null = null;
  if (headerPart) {
    const format = upper(headerPart.format) || "TEXT";
    if (HEADER_FORMATS.has(format)) {
      header = { format: format as HeaderFormat, exampleUrl: strings(headerPart.example?.header_handle)[0] ?? null };
    } else {
      header = { format: "TEXT", text: str(headerPart.text) };
      strings(headerPart.example?.header_text).forEach((value, index) => {
        headerExamples[String(index + 1)] = value;
      });
      namedExamples(headerPart.example?.header_text_named_params, headerExamples);
    }
  }

  const bodyPart = find("BODY");
  const sets = bodyPart?.example?.body_text;
  (Array.isArray(sets) ? strings(sets[0]) : []).forEach((value, index) => {
    bodyExamples[String(index + 1)] = value;
  });
  namedExamples(bodyPart?.example?.body_text_named_params, bodyExamples);

  const buttonsPart = find("BUTTONS");
  const buttons = Array.isArray(buttonsPart?.buttons)
    ? (buttonsPart.buttons as MetaButton[]).map((button): TemplateButton => {
        const kind = BUTTON_KINDS[upper(button?.type)] ?? "other";
        const url = str(button?.url);
        const phone = str(button?.phone_number);
        const exampleUrl = strings(button?.example)[0];
        return {
          kind,
          text: str(button?.text),
          ...(url ? { url } : {}),
          ...(phone ? { phone } : {}),
          ...(exampleUrl ? { exampleUrl } : {}),
        };
      })
    : [];

  return {
    header,
    body: str(bodyPart?.text),
    footer: str(find("FOOTER")?.text),
    buttons,
    headerExamples,
    bodyExamples,
  };
}

/** The fields the list asks Meta for beyond the defaults (`TEMPLATE_LIST_FIELDS`). */
export interface TemplateReviewFields {
  sub_category?: string;
  previous_category?: string;
  rejected_reason?: string;
  quality_score?: { score?: string; reasons?: string[] | null };
  last_updated_time?: string;
}

export type TemplateRecord = TemplateListRow & TemplateReviewFields;

const REJECTION_COPY: Record<string, string> = {
  ABUSIVE_CONTENT: "Abusive content",
  CATEGORY_NOT_AVAILABLE: "Category not available",
  INCORRECT_CATEGORY: "Incorrect category",
  INVALID_FORMAT: "Invalid format",
  PROMOTIONAL: "Promotional content",
  SCAM: "Flagged as a scam",
  TAG_CONTENT_MISMATCH: "Content does not match the category",
};

/** Why Meta rejected the template, or `null` when it says nothing useful. */
export function rejectionReason(row: TemplateRecord): string | null {
  const reason = upper(row.rejected_reason);
  if (!reason || reason === "NONE") return null;
  return REJECTION_COPY[reason] ?? reason.toLowerCase().replaceAll("_", " ");
}

export type QualityTone = "neutral" | "warning" | "destructive";

/** Meta's quality rating in its own WhatsApp Manager words. `null` when absent. */
export function qualityReading(row: TemplateRecord): { label: string; tone: QualityTone } | null {
  switch (upper(row.quality_score?.score)) {
    case "GREEN":
      return { label: "High", tone: "neutral" };
    case "YELLOW":
      return { label: "Medium", tone: "warning" };
    case "RED":
      return { label: "Low", tone: "destructive" };
    case "UNKNOWN":
      return { label: "Not rated yet", tone: "neutral" };
    default:
      return null;
  }
}

/** `Utility`, `Marketing`, `Authentication`. */
export function categoryLabel(category: string | undefined): string {
  const value = str(category).toLowerCase();
  return value ? value[0]?.toUpperCase() + value.slice(1) : "—";
}

/** Meta's `last_updated_time` ("2026-10-02T09:14:31+0000") as a date, or `null`. */
export function lastUpdated(row: TemplateRecord): Date | null {
  const raw = str(row.last_updated_time).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** Meta's edit window: only these statuses can be edited at all. */
export function canEditStatus(status: string | undefined): boolean {
  return ["APPROVED", "REJECTED", "PAUSED"].includes(upper(status));
}

export type AuthoringReading =
  | { ok: true; draft: TemplateDraft }
  | { ok: false; reason: string };

/** Everything else is refused: Meta's edit replaces every component, so one the form cannot hold would be deleted. */
const AUTHORED_TYPES = new Set(["HEADER", "BODY", "FOOTER", "BUTTONS"]);

const HEADER_NOUNS: Record<HeaderFormat | "TEXT", string> = {
  TEXT: "a text header",
  IMAGE: "an image header",
  VIDEO: "a video header",
  DOCUMENT: "a document header",
  LOCATION: "a location header",
};

/**
 * Can the console's form carry this template, and with what draft?
 *
 * The form authors one shape: a positional body, an optional footer and up to
 * three URL buttons. Edit and duplicate are offered only for templates of that
 * shape — anything else would silently drop the parts the form cannot hold,
 * because Meta's edit replaces every component.
 */
export function authoringReading(row: TemplateRecord): AuthoringReading {
  const category = upper(row.category);
  if (category !== "UTILITY" && category !== "MARKETING") {
    return { ok: false, reason: "Authentication templates are managed in WhatsApp Manager." };
  }
  if (upper(row.parameter_format) === "NAMED") {
    return { ok: false, reason: "It uses named variables, which the console does not author yet." };
  }
  const view = templateView(row);
  if (!view || !view.body) return { ok: false, reason: "Meta returned this template without a body." };
  const other = (row.components as { type?: unknown }[]).find(
    (part) => !AUTHORED_TYPES.has(upper(part?.type)),
  );
  if (other) {
    return {
      ok: false,
      reason: `It has a ${upper(other.type).toLowerCase().replaceAll("_", " ")} component, which the console does not author.`,
    };
  }
  if (view.header) {
    return { ok: false, reason: `It has ${HEADER_NOUNS[view.header.format]}, which the console does not author yet.` };
  }
  if (view.buttons.length > 3 || view.buttons.some((button) => button.kind !== "url")) {
    return { ok: false, reason: "Its buttons are not all links, and the console authors link buttons only." };
  }
  const body = analyzeDraftBody(view.body);
  if (!body.ok) return { ok: false, reason: body.reason };
  const count = body.paramCount;
  return {
    ok: true,
    draft: {
      name: str(row.name),
      language: str(row.language),
      category: category as TemplateDraft["category"],
      body: view.body,
      examples: Array.from({ length: count }, (_, index) => view.bodyExamples[String(index + 1)] ?? ""),
      footer: view.footer,
      buttons: view.buttons.map((button) => ({
        text: button.text,
        url: button.url ?? "",
        exampleUrl: button.exampleUrl ?? "",
      })),
    },
  };
}
