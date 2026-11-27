/**
 * What the console can send from one Meta message-template row, and the
 * send-side `components` that fill it.
 *
 * Scope decided deliberately: **body variables, positional `{{1}}..{{n}}` or
 * named `{{customer_name}}`, the fill for any dynamic URL button, one link for
 * a media header, and static quick-reply buttons** (they need nothing at send
 * time; a tap arrives as an ordinary reply). Authentication/OTP templates,
 * copy-code and flow buttons, carousels, limited-time offers, location headers
 * and text headers with a variable are their own project. A template this
 * cannot build gets an honest sentence and no send button rather than a button
 * that fails at Meta.
 *
 * A MEDIA HEADER IS A LINK, NOT AN UPLOAD. Meta accepts either a media id or a
 * public `https://` URL it fetches itself; the console asks for the URL, so
 * this gained a send capability without gaining a file-upload path, a storage
 * decision, or a fetcher of its own.
 *
 * Lives in `@eccos/core` so every surface that authors or sends a template
 * (the console, the MCP server, the gateway) applies one set of rules. Pure: no
 * HTTP, no storage, no framework types.
 */

/** The header formats the console can fill from a link. LOCATION is not one of
 * them: it carries latitude/longitude/name/address rather than an asset. */
export type TemplateHeaderMediaFormat = "image" | "video" | "document";

export interface TemplateHeaderMedia {
  format: TemplateHeaderMediaFormat;
  /** Public `https://` URL. Fetched by Meta, never by Eccos. */
  link: string;
}

/** What a send of one template must fill. */
export interface TemplateVariables {
  /** Meta's `parameter_format`: NAMED parameters travel with their `parameter_name`. */
  format: "positional" | "named";
  /** Body variables in order: `"1"`, `"2"`… or the parameter names. `example` is
   * the value Meta stored with the template, when it has one. */
  body: { key: string; example: string | null }[];
  /** The dynamic URL button slots, in BUTTONS order. `index` is the 0-based
   * slot of that URL button in the template's BUTTONS component; `urlPrefix` is
   * the URL up to its placeholder, for the input's hint. `parameterName` is
   * set for a NAMED template's `{{order_id}}`, which Meta wants sent by name. */
  buttons: { index: number; urlPrefix: string; parameterName?: string }[];
  /** Set when the template's HEADER carries an asset, so the send asks for one
   * link. `null` for a text header or no header at all. */
  headerMedia: TemplateHeaderMediaFormat | null;
}

export type TemplateSendability =
  | ({ kind: "ready"; bodyText: string | null } & TemplateVariables)
  /** `reason` is operator-facing copy: it is rendered verbatim in the sheet. */
  | { kind: "unsupported"; reason: string };

/** The subset of a Meta template row this analysis reads. */
export interface TemplateRow {
  category?: string;
  parameter_format?: string;
  components?: unknown;
}

/** One row of the templates list: what the list shows, plus what `analyzeTemplate` reads. */
export interface TemplateListRow extends TemplateRow {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
}

/** The rows of a `listTemplates` payload (`{ data: [...] }`); any other shape has none. */
export function templateRowsOf(payload: unknown): TemplateListRow[] {
  return typeof payload === "object" && payload !== null && "data" in payload && Array.isArray(payload.data)
    ? (payload.data as TemplateListRow[])
    : [];
}

interface Component {
  type?: string;
  format?: string;
  text?: string;
  buttons?: unknown;
  example?: { body_text?: unknown; body_text_named_params?: unknown };
}

/** Positional placeholder: `{{1}}`, `{{ 2 }}`. */
const POSITIONAL = /\{\{\s*(\d+)\s*\}\}/g;
/** Any placeholder at all, positional or named. */
const ANY_PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;
/** A named parameter as Meta writes it. Shared with the send validator, so a key
 * this analysis offers is a key the gateway accepts. */
const NAMED_KEY = /^[a-z0-9_]{1,128}$/i;

/** A parameter name: Meta's charset, and never a bare number, which is positional. */
function isNamedKey(key: string): boolean {
  return NAMED_KEY.test(key) && !/^\d+$/.test(key);
}

const SEND_THROUGH_API = "Send it through the API instead.";

/** Meta's header formats the console can fill with one link, mapped to the
 * lowercase orthography the SEND-side Graph shape uses. */
const MEDIA_HEADER_FORMATS: Record<string, TemplateHeaderMediaFormat | undefined> = {
  IMAGE: "image",
  VIDEO: "video",
  DOCUMENT: "document",
};

function components(row: TemplateRow): Component[] | null {
  return Array.isArray(row.components) ? (row.components as Component[]) : null;
}

function upper(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase() : "";
}

function text(component: Component): string {
  return typeof component.text === "string" ? component.text : "";
}

/** Meta's stored body examples by key: `body_text[0]` positionally, or `body_text_named_params`. */
function bodyExamples(body: Component | undefined): Map<string, string> {
  const examples = new Map<string, string>();
  const sets = body?.example?.body_text;
  const first = Array.isArray(sets) && Array.isArray(sets[0]) ? (sets[0] as unknown[]) : [];
  first.forEach((value, index) => {
    if (typeof value === "string") examples.set(String(index + 1), value);
  });
  const named = body?.example?.body_text_named_params;
  for (const entry of Array.isArray(named) ? (named as { param_name?: unknown; example?: unknown }[]) : []) {
    if (typeof entry?.param_name === "string" && typeof entry.example === "string") {
      examples.set(entry.param_name, entry.example);
    }
  }
  return examples;
}

const unsupported = (reason: string) => ({ unsupported: `${reason} ${SEND_THROUGH_API}` });

/**
 * What a send of this template must fill, or why the console cannot build it.
 *
 * The order of the checks is the order of the excuses an operator would want to
 * hear: what the template *is* first, then its header, then its buttons, then
 * its body variables.
 */
export function templateVariables(row: TemplateRow): TemplateVariables | { unsupported: string } {
  if (upper(row.category) === "AUTHENTICATION") {
    return unsupported("Authentication templates carry a one-time code the console cannot mint.");
  }
  const declaredNamed = upper(row.parameter_format) === "NAMED";

  const parts = components(row);
  if (parts === null) {
    // A row Meta returned without a `components` array. Treated as a
    // zero-parameter template and sent bare: if Meta actually wanted
    // parameters it answers 132000, which maps to a legible
    // "parameter_mismatch" line. A documented gamble — the alternative is
    // refusing to send `hello_world` on a response shape we cannot control.
    return { format: declaredNamed ? "named" : "positional", body: [], buttons: [], headerMedia: null };
  }

  const buttonSlots: TemplateVariables["buttons"] = [];
  let headerMedia: TemplateHeaderMediaFormat | null = null;

  for (const part of parts) {
    const type = upper(part.type);
    if (type === "CAROUSEL" || type === "LIMITED_TIME_OFFER") {
      return unsupported(
        `This template has a ${type === "CAROUSEL" ? "carousel" : "limited-time offer"}, which the console cannot build.`,
      );
    }
    if (type === "HEADER") {
      const format = upper(part.format);
      if (format !== "TEXT") {
        const media = MEDIA_HEADER_FORMATS[format];
        // LOCATION, and anything Meta adds later: not an asset one link can fill.
        if (!media) {
          return unsupported(`This template's header is a ${format.toLowerCase() || "kind"} the console cannot build.`);
        }
        headerMedia = media;
        continue;
      }
      if (text(part).includes("{{")) {
        return unsupported("This template's header takes a parameter, which the console cannot fill in yet.");
      }
    }
    if (type === "BUTTONS") {
      const buttons = Array.isArray(part.buttons) ? (part.buttons as Component[]) : [];
      for (let index = 0; index < buttons.length; index++) {
        const button = buttons[index] ?? {};
        const buttonType = upper(button.type);
        if (buttonType === "COPY_CODE" || buttonType === "OTP" || buttonType === "FLOW") {
          return unsupported(`This template has a ${buttonType.toLowerCase()} button, which the console cannot build.`);
        }
        const url = (button as { url?: unknown }).url;
        if (typeof url === "string" && url.includes("{{")) {
          const key = /\{\{\s*([^}]+?)\s*\}\}/.exec(url)?.[1] ?? "";
          buttonSlots.push({
            index,
            urlPrefix: url.slice(0, url.indexOf("{{")),
            ...(/^\d+$/.test(key) ? {} : { parameterName: key }),
          });
        }
      }
    }
  }

  const body = parts.find((part) => upper(part.type) === "BODY");
  const bodyText = body ? text(body) : "";
  const examples = bodyExamples(body);
  const keys = [...new Set(Array.from(bodyText.matchAll(ANY_PLACEHOLDER), (match) => match[1] ?? ""))];
  const named = keys.filter((key) => !/^\d+$/.test(key));
  const variables = (format: TemplateVariables["format"], bodyKeys: string[]): TemplateVariables => ({
    format,
    body: bodyKeys.map((key) => ({ key, example: examples.get(key) ?? null })),
    buttons: buttonSlots,
    headerMedia,
  });

  const namedSlots = buttonSlots.filter((slot) => slot.parameterName !== undefined);
  if (declaredNamed || named.length > 0 || namedSlots.length > 0) {
    const lined =
      named.length === keys.length &&
      namedSlots.length === buttonSlots.length &&
      [...named, ...namedSlots.map((slot) => slot.parameterName ?? "")].every(isNamedKey);
    if (!lined) {
      return unsupported("This template's variables cannot be lined up with inputs.");
    }
    return variables("named", named);
  }

  const indices = new Set(Array.from(bodyText.matchAll(POSITIONAL), (match) => Number(match[1])));
  const max = Math.max(0, ...indices);
  // Meta numbers positional parameters 1..n with no gaps. A row that breaks
  // that would make the inputs silently misalign with the message, so it is
  // refused rather than guessed at.
  for (let i = 1; i <= max; i++) {
    if (!indices.has(i)) {
      return unsupported("This template numbers its parameters with a gap, so the console cannot line them up.");
    }
  }
  return variables("positional", Array.from({ length: max }, (_, i) => String(i + 1)));
}

/** `templateVariables` for the send sheet: ready with the body text for its preview, or unsupported. */
export function analyzeTemplate(row: TemplateRow): TemplateSendability {
  const variables = templateVariables(row);
  if ("unsupported" in variables) return { kind: "unsupported", reason: variables.unsupported };
  const body = components(row)?.find((part) => upper(part.type) === "BODY");
  return { kind: "ready", bodyText: body ? text(body) : null, ...variables };
}

/** What fills one send: body values (positional in order, or NAMED by parameter
 * name), dynamic URL button values, and a media header link. */
export interface TemplateValues {
  body?: string[] | Record<string, string>;
  buttons?: { index: number; text: string; parameterName?: string }[];
  headerMedia?: TemplateHeaderMedia;
}

/**
 * Meta's send-side `components` for these values, in Meta's documented order:
 * header, body, buttons. Lowercase types: UPPER is the CREATE-side Graph shape,
 * this is the SEND-side one. A body given by name, and a button with a
 * `parameterName`, carry `parameter_name`, which is what a NAMED template requires.
 */
export function buildSendComponents(values: TemplateValues): Record<string, unknown>[] {
  const { headerMedia, body, buttons = [] } = values;
  const result: Record<string, unknown>[] = [];
  if (headerMedia) {
    result.push({
      type: "header",
      parameters: [{ type: headerMedia.format, [headerMedia.format]: { link: headerMedia.link } }],
    });
  }
  const parameters = Array.isArray(body)
    ? body.map((text) => ({ type: "text", text }))
    : Object.entries(body ?? {}).map(([name, text]) => ({ type: "text", parameter_name: name, text }));
  if (parameters.length > 0) result.push({ type: "body", parameters });
  for (const button of buttons) {
    result.push({
      type: "button",
      sub_type: "url",
      index: String(button.index),
      parameters: [
        { type: "text", ...(button.parameterName ? { parameter_name: button.parameterName } : {}), text: button.text },
      ],
    });
  }
  return result;
}

/** Only an approved template can be sent; everything else is a Meta review state. */
export function canSendTemplate(status: string | undefined): boolean {
  return status?.toUpperCase() === "APPROVED";
}

/**
 * Fill a template body's placeholders with what the operator typed, by key
 * (`"1"` or a parameter name), for the sheet's preview. An unfilled slot keeps
 * its placeholder so the preview never pretends a value exists.
 */
export function previewBody(bodyText: string, values: Record<string, string>): string {
  return bodyText.replace(ANY_PLACEHOLDER, (match, key: string) => values[key]?.trim() || match);
}

// --- Authoring: the inverse of `analyzeTemplate` -----------------------------
//
// Creation lives in this file, next to the analysis it must agree with, and
// shares its `POSITIONAL` / `ANY_PLACEHOLDER` regexes. That adjacency IS the
// enforcement: the create form must never author a template that
// `analyzeTemplate` would later call `unsupported`, because the row Meta
// returns for it is the row the "Send test" sheet reads. The agreement is
// asserted as a property in tests/template-rules.test.ts.

/** Meta's ceiling for a template BODY component. */
export const MAX_BODY_LENGTH = 1024;
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
      // Authoring stays positional: the create form numbers its examples.
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

/** Meta's documented ceiling for a template FOOTER, mirrored here so the
 * create sheet and the server validator share one number. */
export const MAX_FOOTER_LENGTH = 60;
/** A BUTTONS component holds at most 3 URL buttons (Meta's own cap). */
export const MAX_CREATE_BUTTONS = 3;
/** Meta's conservative button-label ceiling, applied at authoring time. */
export const MAX_BUTTON_TEXT_LENGTH = 25;
/** A sanity bound on a button URL; Meta's own ceiling is not documented. */
const MAX_BUTTON_URL_LENGTH = 2000;

/** A URL variable, `{{1}}` or `{{name}}`: the one rule for what makes a URL dynamic. */
export const URL_VARIABLE = /\{\{[^{}]*\}\}/;

export function isDynamicUrl(url: string): boolean {
  return URL_VARIABLE.test(url);
}

/** A `{{` that never closes: neither a static URL nor a variable. */
function unclosedVariable(url: string): boolean {
  return url.includes("{{") && !isDynamicUrl(url);
}

/** One URL button as the create sheet collects it. A dynamic URL (a `{{n}}`
 * placeholder) REQUIRES `exampleUrl`; a static URL carries none. */
export interface DraftButton {
  text: string;
  url: string;
  exampleUrl: string;
}

/**
 * Can the console author this footer text?
 *
 * Static text only — no placeholders and no line breaks, within Meta's
 * documented ceiling. A footer never carries a parameter, so there is nothing
 * for the send sheet to fill later: exactly one shape, and this is it.
 */
export function analyzeDraftFooter(text: string): DraftAnalysis {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, paramCount: 0 };
  if (trimmed.length > MAX_FOOTER_LENGTH) {
    return { ok: false, reason: `A footer is at most ${MAX_FOOTER_LENGTH} characters.` };
  }
  if (/\{\{/.test(trimmed)) {
    return { ok: false, reason: "A footer cannot contain variables like {{1}}." };
  }
  if (/[\n\t]/.test(trimmed)) {
    return { ok: false, reason: "A footer must be a single line of text." };
  }
  return { ok: true, paramCount: 0 };
}

/**
 * Can the console author this set of URL buttons?
 *
 * The mirror of what `analyzeTemplate` admits on the send side: at most three
 * URL buttons (Meta's own ceiling), an https URL, and an example URL required
 * exactly when the URL is dynamic. The console authors link buttons only.
 */
export function analyzeDraftButtons(buttons: DraftButton[]): DraftAnalysis {
  if (buttons.length > MAX_CREATE_BUTTONS) {
    return { ok: false, reason: `A template carries at most ${MAX_CREATE_BUTTONS} buttons.` };
  }
  for (const [index, button] of buttons.entries()) {
    const label = button.text.trim();
    if (!label) {
      return { ok: false, reason: `Button ${index + 1} needs a label.` };
    }
    if (label.length > MAX_BUTTON_TEXT_LENGTH) {
      return {
        ok: false,
        reason: `Button ${index + 1}'s label is over ${MAX_BUTTON_TEXT_LENGTH} characters.`,
      };
    }
    if (/[\n\t]/.test(label)) {
      return { ok: false, reason: `Button ${index + 1}'s label must be one line.` };
    }
    const url = button.url.trim();
    if (!url) {
      return { ok: false, reason: `Button ${index + 1} needs a URL.` };
    }
    if (!/^https?:\/\//.test(url)) {
      return { ok: false, reason: `Button ${index + 1}'s URL must start with https://.` };
    }
    if (url.length > MAX_BUTTON_URL_LENGTH) {
      return { ok: false, reason: `Button ${index + 1}'s URL is over ${MAX_BUTTON_URL_LENGTH} characters.` };
    }
    if (unclosedVariable(url)) {
      return { ok: false, reason: `Button ${index + 1}'s URL has a {{ that is not closed.` };
    }
    const dynamic = isDynamicUrl(url);
    if (dynamic && !button.exampleUrl.trim()) {
      return {
        ok: false,
        reason: `Button ${index + 1} has a dynamic URL and needs an example URL.`,
      };
    }
  }
  return { ok: true, paramCount: 0 };
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

// --- Request rules: what an authoring or send request may carry --------------
//
// Each takes the request's fields as a record and throws an `Error` whose
// message is the first rule broken, worded for the operator. The caller owns
// everything around them: reading the request, the WABA and number it names,
// the recipient, and the idempotency key.

/**
 * A request array's elements by index. A Workers RPC caller sends structured
 * clones, which keep an array's holes, and `map` skips a hole; read this way a
 * hole is `undefined` and is refused like any other missing value.
 */
function elements(list: unknown[]): unknown[] {
  return Array.from({ length: list.length }, (_, index) => list[index]);
}

/** Meta's template-name charset. */
export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
/** `en` / `es` / `en_US` / `pt_BR`. */
export const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;
/** Graph template ids (`hsm_id`) are numeric. */
export const TEMPLATE_ID_PATTERN = /^[0-9]{1,32}$/;
/** Meta's ceiling for one text parameter, in characters. */
export const MAX_BODY_PARAM_LENGTH = 1024;
/** A BUTTONS component carries at most 3 URL buttons (Meta's own cap). */
const MAX_BUTTON_PARAMS = 3;
/** Upper bound for a URL button's 0-based slot index in the BUTTONS component. */
const MAX_BUTTON_URL_INDEX = 9;

export type TemplateCategory = "MARKETING" | "UTILITY";

/** The content half of a console-authored template, shared by create and edit. */
export interface TemplateContent {
  bodyText: string;
  bodyExamples?: string[];
  footerText?: string;
  buttons?: { text: string; url: string; exampleUrl?: string }[];
}

export interface TemplateDraft extends TemplateContent {
  name: string;
  language: string;
  category: TemplateCategory;
}

/** One translation's new content. `category` is absent to keep the current one. */
export interface TemplateEdit extends TemplateContent {
  templateId: string;
  name: string;
  language: string;
  category?: TemplateCategory;
}

/** What a test send asks of the template: which one, and the values that fill it. */
export interface TemplateSendRequest {
  templateName: string;
  languageCode: string;
  bodyParams?: string[];
  bodyValues?: Record<string, string>;
  buttonParams?: { index: number; text: string; parameterName?: string }[];
  headerMedia?: TemplateHeaderMedia;
}

/**
 * The send rules: the template's name and language, then its body values
 * (positional `bodyParams`, or NAMED `bodyValues` by parameter name, never
 * both), its dynamic URL button values and its media header link.
 *
 * `buttonParams` gets the same treatment as `bodyParams`: at most three
 * entries, an integer 0-based slot index within bounds, and a text value
 * without line breaks. Included only when non-empty, exactly like
 * `bodyParams`.
 */
export function validateTemplateSend(record: Record<string, unknown>): TemplateSendRequest {
  if (typeof record.templateName !== "string" || !TEMPLATE_NAME_PATTERN.test(record.templateName.trim())) {
    throw new Error("invalid template name");
  }
  if (typeof record.languageCode !== "string" || !LANGUAGE_PATTERN.test(record.languageCode.trim())) {
    throw new Error("invalid template language");
  }
  const raw = record.bodyParams;
  if (raw !== undefined && !Array.isArray(raw)) throw new Error("bodyParams must be an array");
  const bodyParams = (raw ?? []) as unknown[];
  if (bodyParams.length > MAX_BODY_PARAMS) throw new Error("too many template parameters");
  const values = elements(bodyParams).map(bodyValue);
  const named = namedBodyValues(record.bodyValues);
  if (values.length > 0 && named.length > 0) throw new Error("send bodyParams or bodyValues, not both");
  const rawButtons = record.buttonParams;
  if (rawButtons !== undefined && !Array.isArray(rawButtons)) {
    throw new Error("buttonParams must be an array");
  }
  const buttonParams = (rawButtons ?? []) as unknown[];
  if (buttonParams.length > MAX_BUTTON_PARAMS) throw new Error("too many button parameters");
  const buttons = elements(buttonParams).map((value) => {
    const button = value as Record<string, unknown>;
    if (!button || typeof button !== "object" || Array.isArray(button)) {
      throw new Error("button parameters must be objects");
    }
    if (typeof button.index !== "number" || !Number.isInteger(button.index)) {
      throw new Error("button parameter index must be a whole number");
    }
    if (button.index < 0 || button.index > MAX_BUTTON_URL_INDEX) {
      throw new Error("button parameter index is out of range");
    }
    if (typeof button.text !== "string") throw new Error("every button parameter needs a value");
    const text = button.text.trim();
    if (!text) throw new Error("every button parameter needs a value");
    if (text.length > MAX_BODY_PARAM_LENGTH) throw new Error("button parameter is too long");
    if (/[\n\t]/.test(text)) {
      throw new Error("button parameters cannot contain line breaks");
    }
    const name = button.parameterName;
    if (name !== undefined && (typeof name !== "string" || !isNamedKey(name))) {
      throw new Error("button parameterName must be a parameter name");
    }
    return { index: button.index, text, ...(name !== undefined ? { parameterName: name } : {}) };
  });
  const headerMedia = validateHeaderMedia(record.headerMedia);
  return {
    templateName: record.templateName.trim(),
    languageCode: record.languageCode.trim(),
    ...(values.length > 0 ? { bodyParams: values } : {}),
    ...(named.length > 0 ? { bodyValues: Object.fromEntries(named) } : {}),
    ...(buttons.length > 0 ? { buttonParams: buttons } : {}),
    ...(headerMedia ? { headerMedia } : {}),
  };
}

function bodyValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("template parameters must be strings");
  const text = value.trim();
  if (!text) throw new Error("every template parameter needs a value");
  if (text.length > MAX_BODY_PARAM_LENGTH) throw new Error("template parameter is too long");
  // Meta rejects newlines and tabs inside a text parameter outright, so this
  // is a refusal the operator can act on rather than a 132000 from Graph.
  if (/[\n\t]/.test(text)) throw new Error("template parameters cannot contain line breaks");
  return text;
}

/** NAMED body values by parameter name. A numbered key belongs in `bodyParams`. */
function namedBodyValues(value: unknown): [string, string][] {
  if (value === undefined) return [];
  const proto = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) throw new Error("bodyValues must be an object");
  const entries = Object.entries(value as object);
  if (entries.length > MAX_BODY_PARAMS) throw new Error("too many template parameters");
  if (new Set(entries.map(([key]) => key.toLowerCase())).size !== entries.length) {
    throw new Error("bodyValues keys must be distinct");
  }
  return entries.map(([key, text]) => {
    if (!isNamedKey(key)) throw new Error("bodyValues keys must be parameter names");
    return [key, bodyValue(text)];
  });
}

/**
 * The media header's one field: a link Meta will fetch.
 *
 * `https` ONLY, and that is not decoration. Meta dereferences this URL from its
 * own network, so an `http` link leaks the asset in transit and a `data:` or
 * `file:` one is a shape Meta cannot use at all. Embedded credentials are
 * refused too — a URL carrying a username or password is one an operator did
 * not mean to hand to a third party's fetcher.
 *
 * Eccos itself never dereferences it: this validator parses the URL, it does
 * not open it, so nothing here can be turned into a request made on Eccos'
 * behalf.
 */
function validateHeaderMedia(value: unknown): TemplateHeaderMedia | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("headerMedia must be an object");
  }
  const media = value as Record<string, unknown>;
  const format = media.format;
  if (typeof format !== "string" || !HEADER_MEDIA_FORMATS.includes(format as TemplateHeaderMediaFormat)) {
    throw new Error("headerMedia format must be image, video or document");
  }
  if (typeof media.link !== "string") throw new Error("the header needs a media link");
  const link = media.link.trim();
  if (!link) throw new Error("the header needs a media link");
  if (link.length > MAX_HEADER_LINK_LENGTH) throw new Error("header media link is too long");
  if (/\s/.test(link)) throw new Error("header media link cannot contain spaces or line breaks");
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error("header media link must be a full URL");
  }
  if (url.protocol !== "https:" || !link.startsWith("https://")) {
    throw new Error("header media link must start with https://");
  }
  if (url.username || url.password) {
    throw new Error("header media link must not carry credentials");
  }
  return { format: format as TemplateHeaderMediaFormat, link };
}

const HEADER_MEDIA_FORMATS: TemplateHeaderMediaFormat[] = ["image", "video", "document"];
/** Meta's own cap is far higher; this is a sanity bound on operator input. */
const MAX_HEADER_LINK_LENGTH = 2048;

/**
 * The authoring rules: name, language, category, then the content.
 *
 * It runs the very `analyzeDraftBody` the create form runs, so a request that
 * skipped the UI cannot author a body the "Send test" sheet would later refuse.
 *
 * The refused set: AUTHENTICATION, media headers, quick-replies, carousels and
 * OTP/copy-code/flow buttons are not authored here.
 */
export function validateTemplateDraft(record: Record<string, unknown>): TemplateDraft {
  if (typeof record.name !== "string" || !TEMPLATE_NAME_PATTERN.test(record.name.trim())) {
    throw new Error("template name must be lowercase letters, numbers and underscores");
  }
  if (typeof record.language !== "string" || !LANGUAGE_PATTERN.test(record.language.trim())) {
    throw new Error("invalid template language");
  }
  if (record.category !== "MARKETING" && record.category !== "UTILITY") {
    // AUTHENTICATION is absent by design, not by omission: those are preset
    // content plus OTP buttons, a creation shape this console does not build.
    throw new Error("template category must be MARKETING or UTILITY");
  }
  return {
    name: record.name.trim(),
    language: record.language.trim(),
    category: record.category,
    ...validateTemplateContent(record),
  };
}

/**
 * The edit rules. `name` and `language` identify the translation and cannot
 * change; `category` is optional because Meta refuses to change an APPROVED
 * template's.
 */
export function validateTemplateEdit(record: Record<string, unknown>): TemplateEdit {
  if (typeof record.templateId !== "string" || !TEMPLATE_ID_PATTERN.test(record.templateId.trim())) {
    throw new Error("invalid template id");
  }
  if (typeof record.name !== "string" || !TEMPLATE_NAME_PATTERN.test(record.name.trim())) {
    throw new Error("invalid template name");
  }
  if (typeof record.language !== "string" || !LANGUAGE_PATTERN.test(record.language.trim())) {
    throw new Error("invalid template language");
  }
  const category = record.category;
  if (category !== undefined && category !== "MARKETING" && category !== "UTILITY") {
    throw new Error("template category must be MARKETING or UTILITY");
  }
  return {
    templateId: record.templateId.trim(),
    name: record.name.trim(),
    language: record.language.trim(),
    ...(category ? { category } : {}),
    ...validateTemplateContent(record),
  };
}

/**
 * The content rules, shared by create and edit: a body `analyzeDraftBody`
 * accepts, exactly one example per `{{n}}`, a static footer, and up to three
 * https URL buttons. A dynamic URL (a `{{n}}` placeholder) REQUIRES its
 * example URL; a static URL carries none.
 *
 * Examples are mandatory, one per `{{n}}`: Meta requires an example value for
 * every parameter, and they are what its reviewers read. Their character rules
 * are the send rules', byte for byte: an example travels to Meta as content
 * exactly as a send parameter does.
 */
function validateTemplateContent(record: Record<string, unknown>): TemplateContent {
  if (typeof record.bodyText !== "string") throw new Error("template body is required");
  // Not trimmed: leading and trailing whitespace is part of the message Meta
  // will store, and silently rewriting an operator's body would make the
  // preview a lie. Only its emptiness is judged on the trimmed form.
  const bodyText = record.bodyText;
  const draft = analyzeDraftBody(bodyText);
  if (!draft.ok) throw new Error(draft.reason);

  const raw = record.bodyExamples;
  if (raw !== undefined && !Array.isArray(raw)) throw new Error("bodyExamples must be an array");
  const examples = (raw ?? []) as unknown[];
  if (examples.length > MAX_BODY_PARAMS) throw new Error("too many template parameters");
  if (examples.length !== draft.paramCount) {
    throw new Error(`this body needs exactly ${draft.paramCount} example value(s)`);
  }
  const values = elements(examples).map((value) => {
    if (typeof value !== "string") throw new Error("example values must be strings");
    const text = value.trim();
    if (!text) throw new Error("every variable needs an example value");
    if (text.length > MAX_BODY_PARAM_LENGTH) throw new Error("example value is too long");
    // Meta rejects newlines and tabs inside a text parameter outright — the
    // same rule the send validator applies, for the same reason.
    if (/[\n\t]/.test(text)) throw new Error("example values cannot contain line breaks");
    return text;
  });

  const footerRaw = record.footerText;
  if (footerRaw !== undefined) {
    if (typeof footerRaw !== "string") throw new Error("footer text is required when present");
    const footer = footerRaw.trim();
    if (!footer) throw new Error("footer text cannot be empty");
    if (footer.length > MAX_FOOTER_LENGTH) throw new Error("footer text is too long");
    if (/\{\{/.test(footer)) throw new Error("footer text cannot contain placeholders");
    if (/[\n\t]/.test(footer)) throw new Error("footer text cannot contain line breaks");
  }

  const rawButtons = record.buttons;
  if (rawButtons !== undefined && !Array.isArray(rawButtons)) throw new Error("buttons must be an array");
  const buttonList = (rawButtons ?? []) as unknown[];
  if (buttonList.length > MAX_CREATE_BUTTONS) throw new Error("a template can carry at most 3 buttons");
  const buttons = elements(buttonList).map((value) => {
    const button = value as Record<string, unknown>;
    if (!button || typeof button !== "object" || Array.isArray(button)) {
      throw new Error("buttons must be objects");
    }
    if (typeof button.text !== "string") throw new Error("every button needs a label");
    const text = button.text.trim();
    if (!text) throw new Error("every button needs a label");
    if (text.length > MAX_BUTTON_TEXT_LENGTH) throw new Error("button label is too long");
    if (typeof button.url !== "string") throw new Error("every button needs a url");
    const url = button.url.trim();
    if (!url) throw new Error("every button needs a url");
    if (!/^https?:\/\//.test(url)) throw new Error("button url must be https");
    if (url.length > MAX_BUTTON_URL_LENGTH) throw new Error("button url is at most 2000 characters");
    if (/[\n\t]/.test(text) || /[\n\t]/.test(url)) {
      throw new Error("buttons cannot contain line breaks");
    }
    if (unclosedVariable(url)) throw new Error("button url has an unclosed variable");
    const dynamic = isDynamicUrl(url);
    if (dynamic) {
      if (typeof button.exampleUrl !== "string") {
        throw new Error("a dynamic URL button needs an example url");
      }
      const example = button.exampleUrl.trim();
      if (!example) throw new Error("a dynamic URL button needs an example url");
      if (!/^https?:\/\//.test(example)) {
        throw new Error("button example url must be https");
      }
    } else if (button.exampleUrl !== undefined && button.exampleUrl !== "") {
      throw new Error("a static URL button carries no example");
    }
    return {
      text,
      url,
      ...(dynamic && button.exampleUrl
        ? { exampleUrl: String(button.exampleUrl).trim() }
        : {}),
    };
  });

  return {
    bodyText,
    ...(values.length > 0 ? { bodyExamples: values } : {}),
    ...(footerRaw !== undefined ? { footerText: String(footerRaw).trim() } : {}),
    ...(buttons.length > 0 ? { buttons } : {}),
  };
}
