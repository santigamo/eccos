/**
 * What the console's "Send test" sheet can actually build from one Meta
 * message-template row.
 *
 * Scope decided deliberately: **positional `{{1}}..{{n}}` body parameters
 * only.** That is the shape `hello_world` (zero parameters, the App Review
 * screencast template) and most real templates take, and it is one small pure
 * parser. Everything else — media headers need an asset-upload flow, named
 * parameters need a different request shape, authentication/OTP templates,
 * dynamic-URL and flow buttons, carousels — is its own project. A template this
 * cannot build gets an honest sentence and no send button rather than a button
 * that fails at Meta.
 *
 * Pure, type-free of `cloudflare:workers`, so it is exercisable directly under
 * plain `bun test` (same discipline as `lib/failure.ts`).
 */

export type TemplateSendability =
  | { kind: "ready"; paramCount: number; bodyText: string | null }
  /** `reason` is operator-facing copy: it is rendered verbatim in the sheet. */
  | { kind: "unsupported"; reason: string };

/** The subset of a Meta template row this analysis reads. */
export interface TemplateRow {
  category?: string;
  parameter_format?: string;
  components?: unknown;
}

interface Component {
  type?: string;
  format?: string;
  text?: string;
  buttons?: unknown;
}

/** Positional placeholder: `{{1}}`, `{{ 2 }}`. */
const POSITIONAL = /\{\{\s*(\d+)\s*\}\}/g;
/** Any placeholder at all, positional or named. */
const ANY_PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

const SEND_THROUGH_API = "Send it through the API instead.";

function components(row: TemplateRow): Component[] | null {
  return Array.isArray(row.components) ? (row.components as Component[]) : null;
}

function upper(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase() : "";
}

function text(component: Component): string {
  return typeof component.text === "string" ? component.text : "";
}

/** Does this text carry a placeholder that is not a bare positional index? */
function hasNamedPlaceholder(value: string): boolean {
  for (const match of value.matchAll(ANY_PLACEHOLDER)) {
    if (!/^\d+$/.test(match[1] ?? "")) return true;
  }
  return false;
}

function unsupported(reason: string): TemplateSendability {
  return { kind: "unsupported", reason };
}

/**
 * Decide whether the sheet can send this template, and with how many inputs.
 *
 * The order of the checks is the order of the excuses an operator would want to
 * hear: what the template *is* first, then its header, then its buttons, then
 * its body parameters.
 */
export function analyzeTemplate(row: TemplateRow): TemplateSendability {
  if (upper(row.category) === "AUTHENTICATION") {
    return unsupported(
      `Authentication templates carry a one-time code the console cannot mint. ${SEND_THROUGH_API}`,
    );
  }
  if (upper(row.parameter_format) === "NAMED") {
    return unsupported(
      `This template uses named parameters, which the console cannot fill in yet. ${SEND_THROUGH_API}`,
    );
  }

  const parts = components(row);
  if (parts === null) {
    // A row Meta returned without a `components` array. Treated as a
    // zero-parameter template and sent bare: if Meta actually wanted
    // parameters it answers 132000, which maps to a legible
    // "parameter_mismatch" line. A documented gamble — the alternative is
    // refusing to send `hello_world` on a response shape we cannot control.
    return { kind: "ready", paramCount: 0, bodyText: null };
  }

  for (const part of parts) {
    const type = upper(part.type);
    if (type === "CAROUSEL" || type === "LIMITED_TIME_OFFER") {
      return unsupported(
        `This template has a ${type === "CAROUSEL" ? "carousel" : "limited-time offer"}, which the console cannot build. ${SEND_THROUGH_API}`,
      );
    }
    if (type === "HEADER") {
      if (upper(part.format) !== "TEXT") {
        return unsupported(
          `This template's header carries media, which needs an uploaded asset. ${SEND_THROUGH_API}`,
        );
      }
      if (text(part).includes("{{")) {
        // One parameter group only in v1: a header placeholder would need its
        // own component in the request, and mixing the two is where positional
        // numbering starts lying to the operator.
        return unsupported(
          `This template's header takes a parameter, which the console cannot fill in yet. ${SEND_THROUGH_API}`,
        );
      }
    }
    if (type === "BUTTONS") {
      const buttons = Array.isArray(part.buttons) ? (part.buttons as Component[]) : [];
      for (const button of buttons) {
        const buttonType = upper(button.type);
        if (buttonType === "COPY_CODE" || buttonType === "OTP" || buttonType === "FLOW") {
          return unsupported(
            `This template has a ${buttonType.toLowerCase()} button, which the console cannot build. ${SEND_THROUGH_API}`,
          );
        }
        const url = (button as { url?: unknown }).url;
        if (typeof url === "string" && url.includes("{{")) {
          return unsupported(
            `This template has a button with a dynamic URL, which the console cannot fill in yet. ${SEND_THROUGH_API}`,
          );
        }
      }
    }
  }

  const body = parts.find((part) => upper(part.type) === "BODY");
  const bodyText = body ? text(body) : "";
  if (hasNamedPlaceholder(bodyText)) {
    return unsupported(
      `This template uses named parameters, which the console cannot fill in yet. ${SEND_THROUGH_API}`,
    );
  }

  const indices = new Set<number>();
  for (const match of bodyText.matchAll(POSITIONAL)) {
    indices.add(Number(match[1]));
  }
  if (indices.size === 0) {
    return { kind: "ready", paramCount: 0, bodyText: body ? bodyText : null };
  }
  const max = Math.max(...indices);
  // Meta numbers positional parameters 1..n with no gaps. A row that breaks
  // that would make the sheet's inputs silently misalign with the message, so
  // it is refused rather than guessed at.
  for (let i = 1; i <= max; i++) {
    if (!indices.has(i)) {
      return unsupported(
        `This template numbers its parameters with a gap, so the console cannot line them up. ${SEND_THROUGH_API}`,
      );
    }
  }
  return { kind: "ready", paramCount: max, bodyText };
}

/** Only an approved template can be sent; everything else is a Meta review state. */
export function canSendTemplate(status: string | undefined): boolean {
  return status?.toUpperCase() === "APPROVED";
}

/**
 * Fill a template body's placeholders with what the operator typed, for the
 * sheet's preview. An unfilled slot keeps its `{{n}}` so the preview never
 * pretends a value exists.
 */
export function previewBody(bodyText: string, values: string[]): string {
  return bodyText.replace(POSITIONAL, (match, index) => values[Number(index) - 1]?.trim() || match);
}

// --- Authoring: the inverse of `analyzeTemplate` -----------------------------
//
// Creation lives in this file, next to the analysis it must agree with, and
// shares its `POSITIONAL` / `ANY_PLACEHOLDER` regexes. That adjacency IS the
// enforcement: the create form must never author a template that
// `analyzeTemplate` would later call `unsupported`, because the row Meta
// returns for it is the row the "Send test" sheet reads. The agreement is
// asserted as a property in tests/template-params.test.ts.

/** Meta's ceiling for a template BODY component. */
const MAX_BODY_LENGTH = 1024;
/** Parity with the send validator's cap on positional parameters. */
export const MAX_BODY_PARAMS = 30;

export type DraftAnalysis =
  | { ok: true; paramCount: number }
  /** `reason` is operator-facing copy: it is rendered verbatim under the field,
   * the same contract as `TemplateSendability`'s `unsupported.reason`. */
  | { ok: false; reason: string };

/**
 * Can the console author this body, and with how many example values?
 *
 * These are BLOCKERS, and every one of them is either a Meta rule or the mirror
 * of a refusal `analyzeTemplate` already makes on the send side. Review
 * heuristics do not belong here — see {@link draftWarnings}.
 */
export function analyzeDraftBody(text: string): DraftAnalysis {
  if (text.trim().length === 0) {
    return { ok: false, reason: "The body cannot be empty." };
  }
  if (text.length > MAX_BODY_LENGTH) {
    return {
      ok: false,
      reason: `The body is ${text.length} characters; Meta allows ${MAX_BODY_LENGTH}.`,
    };
  }
  for (const match of text.matchAll(ANY_PLACEHOLDER)) {
    if (!/^\d+$/.test(match[1] ?? "")) {
      // The send sheet refuses named parameters outright, so authoring one here
      // would create a template the console itself could not send.
      return {
        ok: false,
        reason: "Named parameters cannot be created here — use {{1}}, {{2}}… instead.",
      };
    }
  }

  const indices = new Set<number>();
  for (const match of text.matchAll(POSITIONAL)) {
    indices.add(Number(match[1]));
  }
  if (indices.size === 0) return { ok: true, paramCount: 0 };

  if (indices.has(0)) {
    // Meta numbers from 1. `analyzeTemplate` reads `{{0}}` as "no parameters"
    // and would happily send the literal text, so the form refuses to author it
    // rather than shipping a body with a placeholder nothing ever fills.
    return { ok: false, reason: "Variables are numbered from {{1}} — {{0}} is not one." };
  }

  const max = Math.max(...indices);
  if (max > MAX_BODY_PARAMS) {
    return { ok: false, reason: `A template body takes at most ${MAX_BODY_PARAMS} variables.` };
  }
  // Meta numbers positional parameters 1..n with no gaps, and `analyzeTemplate`
  // refuses a row that breaks that rather than guessing — so the create form
  // refuses to author one in the first place.
  for (let i = 1; i <= max; i++) {
    if (!indices.has(i)) {
      return {
        ok: false,
        reason: `Variables must run {{1}} to {{${max}}} with no gaps — {{${i}}} is missing.`,
      };
    }
  }
  return { ok: true, paramCount: max };
}

/**
 * Review risks worth mentioning, none of them worth blocking.
 *
 * Both are RESELLER-SOURCED rejection heuristics (Syniverse, Clickatell), not
 * rules Meta publishes — which is exactly why they warn instead of wall. Meta
 * reviews the template; the console does not pre-empt that with refusals it
 * cannot source. Rendered amber, and the submit button stays live.
 */
export function draftWarnings(text: string): string[] {
  const warnings: string[] = [];
  const body = text.trim();
  if (body.length === 0) return warnings;

  const analysis = analyzeDraftBody(text);
  if (!analysis.ok || analysis.paramCount === 0) return warnings;

  if (/^\{\{\s*\d+\s*\}\}/.test(body) || /\{\{\s*\d+\s*\}\}$/.test(body)) {
    warnings.push(
      "Templates that start or end with a variable are a common rejection reason. Consider surrounding it with text.",
    );
  }
  // "Too many variables relative to message length" is the other heuristic
  // reviewers cite. Three plain words per variable is the line drawn here — a
  // judgement call, deliberately loose, because a false alarm costs a sentence
  // and a false silence costs a rejection.
  const words = body.replace(ANY_PLACEHOLDER, " ").trim().split(/\s+/).filter(Boolean).length;
  if (words < analysis.paramCount * 3) {
    warnings.push(
      "This body is mostly variables. Reviewers reject templates whose meaning is not clear without them.",
    );
  }
  return warnings;
}

/**
 * Coerce what the operator typed into Meta's template-name charset
 * (`^[a-z0-9_]{1,512}$`), applied as they type — WhatsApp Manager's own
 * behaviour, and the reason the field never has to reject anything.
 *
 * Idempotent: the field shows exactly what the API will receive.
 */
export function normalizeTemplateName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 512);
}
