import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { createAuth, type Auth } from "../auth/auth";
import { authConfigFromEnv } from "../auth/config";
import { auditEvent } from "./audit";
import type { SessionEvent } from "../lib/embedded-signup";
// The console's authoring gate, shared with the create sheet — and, by
// construction, the same module as `analyzeTemplate`, which is what makes the
// two agree. See `lib/template-params.ts`.
import { analyzeDraftBody } from "../lib/template-params";
import {
  requireAuthContext,
  requireGatewayPermission,
  UnauthorizedError,
} from "../auth/server-auth";
import { ForbiddenError, resolveMemberships } from "../auth/tenant";
import type { ForbiddenReason, GatewayAction, Membership } from "../auth/tenant";
import type {
  AccountResources,
  ConnectExchangeResult,
  ConnectStartResult,
  CreateTemplateInput,
  CreateTemplateResult,
  DeleteTemplateInput,
  DeleteTemplateResult,
  DeliveryListOpts,
  DeliveryRecord,
  GatewayApi,
  GatewayStatus,
  InboundRow,
  ManualConnectResult,
  OutboundRow,
  ReconcileWabaResult,
  ResubscribeResult,
  SendTemplateTestInput,
  SendTemplateTestResult,
  SetSubscriberConfigInput,
  SubscriberConfig,
} from "@eccos/gateway-contract";

type DashboardListOpts = Omit<DeliveryListOpts, "wabaId">;

// Re-export the shared contract types the routes render against, so the whole
// dashboard reads the operator surface from a single source of truth
// (`@eccos/gateway-contract`) — no more hand-mirrored shapes.
export type {
  AccountResources,
  ConnectExchangeResult,
  ConnectStartResult,
  CreateTemplateFailureCode,
  CreateTemplateResult,
  DeleteTemplateResult,
  DeliveryRecord,
  GatewayStatus,
  Health,
  InboundRow,
  ManualConnectFailureCode,
  ManualConnectResult,
  OperatorCounts,
  OutboundRow,
  ProvisioningStatus,
  ReconcileWabaResult,
  ResubscribeResult,
  SendTemplateTestResult,
  SendTestFailureCode,
  SetSubscriberConfigInput,
  SubscriberConfig,
  TokenWabaCandidate,
} from "@eccos/gateway-contract";

/**
 * Which class of failure a server function hit (eccos-k5a).
 *
 * Decided at the boundary from the THROWN ERROR'S TYPE, never from its message.
 * `UnauthorizedError` / `ForbiddenError` come out of the identity plane long
 * before any RPC is attempted, so a page that receives one must not claim the
 * gateway is unreachable: only `"unreachable"` has established that.
 */
export type FailureKind = "unreachable" | "unauthenticated" | "forbidden";

/** The `{ ok: false }` half of {@link Result}, carrying what actually failed. */
export interface Failure {
  ok: false;
  kind: FailureKind;
  /** The underlying message. Diagnostic detail, never the UI's discriminator. */
  error: string;
  /** Which authorization dead end this is. Present for `kind: "forbidden"`. */
  reason?: ForbiddenReason;
  /**
   * The organizations to choose between. Populated only for
   * `reason: "select-organization"`, where the choice IS the remedy.
   */
  organizations?: Membership[];
}

/**
 * Discriminated result wrapper. Every server function narrows an unconfigured
 * or unreachable gateway — and every authorization refusal — to `{ ok: false }`
 * instead of throwing, so pages render a graceful state and a plain
 * `vite build` / SSR without a running gateway never crashes.
 */
export type Result<T> = { ok: true; data: T } | Failure;

export type { ForbiddenReason, Membership } from "../auth/tenant";

/**
 * Identity-plane access (contract §1/§5): every server function resolves the
 * session server-side and re-validates the organization permission via the
 * `auth/server-auth` seam. There is no installation identity, no
 * browser-supplied accountId, and no cross-request authorization caching.
 */

/** Build the request-scoped auth instance from the Worker bindings. */
function requestAuth(): Auth {
  return createAuth(authConfigFromEnv(env));
}

/** Authenticated actor context for audit events. */
interface ActorContext {
  organizationId: string;
  session: { userId: string; email: string };
}

async function requireActor(action: "view" | "operate" | "configure" | "administer" | "erase"): Promise<ActorContext> {
  // One auth instance and one Request per actor resolution; the request-scoped
  // session memo (request-memo.ts) additionally dedupes the underlying
  // `auth.api.getSession` to a single D1 read per request (eccos-ya5).
  const auth = requestAuth();
  const request = getRequest();
  const organizationId = await requireGatewayPermission(auth, request, action);
  const { session } = await requireAuthContext(auth, request);
  return { organizationId, session };
}

/**
 * Arbitrary JSON value. TanStack Start validates that server-function return
 * types are serializable and rejects bare `unknown`, so the contract's
 * `TemplatesResult` (whose `data` / `error` are `unknown`) is surfaced across
 * the boundary through this JSON type — semantically the same untyped payload,
 * just serialization-checkable. The templates route re-narrows `data`.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type TemplatesResult = { ok: true; data: Json } | { ok: false; error: Json };

export type GatewayStatusResult = { ok: true; status: GatewayStatus } | Failure;

export interface DashboardScope {
  accountId: string;
  selectedWabaId: string;
  resources: AccountResources;
}

export interface DashboardOverview {
  status: GatewayStatus;
  scope: DashboardScope;
}

export type DashboardOverviewResult = Result<DashboardOverview>;
export type DashboardState =
  | { stage: "unassigned" }
  | { stage: "no-organization" }
  | { stage: "account-ready"; resources: AccountResources }
  | { stage: "ready"; status: GatewayStatus; scope: DashboardScope };
export type DashboardStateResult = Result<DashboardState>;
export type DashboardScopeInput = { wabaId?: string };

const WABA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PHONE_NUMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Digits only, E.164's 15-digit ceiling — what the Cloud API accepts as `to`. */
const RECIPIENT_PATTERN = /^[0-9]{5,15}$/;
/** Meta's template-name charset. */
const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
/** `en` / `es` / `en_US` / `pt_BR`. */
const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const MAX_BODY_PARAMS = 30;
const MAX_BODY_PARAM_LENGTH = 1024;
/** A BUTTONS component carries at most 3 URL buttons (Meta's own cap). */
const MAX_BUTTON_PARAMS = 3;
/** Upper bound for a URL button's 0-based slot index in the BUTTONS component. */
const MAX_BUTTON_URL_INDEX = 9;
/** Meta's documented ceiling for a template footer, and the console's own. */
const MAX_FOOTER_LENGTH = 60;
/** Meta's conservative button-label ceiling, applied at authoring time. */
const MAX_BUTTON_TEXT_LENGTH = 25;
/** URL-button count cap on authoring, mirroring the send-side one. */
const MAX_CREATE_BUTTONS = 3;
/** Graph template ids (`hsm_id`) are numeric. */
const TEMPLATE_ID_PATTERN = /^[0-9]{1,32}$/;
/** A pasted Meta access token: printable ASCII, no whitespace. */
const META_TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const MIN_META_TOKEN_LENGTH = 20;
const MAX_META_TOKEN_LENGTH = 1024;
/**
 * A WhatsApp Business Account id the operator TYPED. Every other `wabaId` the
 * console sends came out of its own registry; this one is hand-copied from
 * Business settings, so the shape is Meta's (numeric) and the ceiling is real.
 */
const TYPED_WABA_ID_PATTERN = /^[0-9]{1,32}$/;

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid dashboard request");
  }
  return input as Record<string, unknown>;
}

function optionalWabaId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("wabaId must be a string");
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!WABA_ID_PATTERN.test(normalized)) throw new Error("invalid wabaId");
  return normalized;
}

/**
 * The typed twin of {@link optionalWabaId}, for the one input an operator
 * writes by hand. Same trim / empty→undefined contract; a stricter shape
 * (Meta's ids are digits) and a sentence the panel can show, naming the
 * shape and never the value.
 */
function typedWabaId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("wabaId must be a string");
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!TYPED_WABA_ID_PATTERN.test(normalized)) {
    throw new Error(
      "that does not look like a WhatsApp Business Account id — digits only, without spaces or a URL",
    );
  }
  return normalized;
}

function validateScopeInput(input: unknown): DashboardScopeInput | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  return wabaId ? { wabaId } : {};
}

function validateDeliveryInput(input: unknown): (DashboardListOpts & DashboardScopeInput) | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  const status = record.status === undefined ? undefined : record.status;
  if (status !== undefined && (typeof status !== "string" || status.length === 0 || status.length > 100)) {
    throw new Error("status must be a non-empty string");
  }
  const limit = record.limit === undefined ? undefined : record.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
    throw new Error("limit must be a positive integer");
  }
  const before = record.before === undefined ? undefined : record.before;
  if (before !== undefined && (typeof before !== "number" || !Number.isSafeInteger(before) || before <= 0)) {
    throw new Error("before must be a positive integer");
  }
  return { ...(wabaId ? { wabaId } : {}), ...(status !== undefined ? { status } : {}), ...(limit !== undefined ? { limit } : {}), ...(before !== undefined ? { before } : {}) };
}

function validateRetryInput(input: unknown): { id: number; wabaId: string } {
  const record = inputRecord(input);
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id <= 0) {
    throw new Error("id must be a positive integer");
  }
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  return { id: record.id, wabaId };
}

/** A WABA the operator is asking about by id; the account is never theirs to pick. */
function validateWabaInput(input: unknown): { wabaId: string } {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  return { wabaId };
}

/**
 * The forwarding-target write, in the vocabulary the contract now speaks
 * ({@link SetSubscriberConfigInput}): every field states ONE intention.
 *
 * `url` is a string to set the target and `null` to REMOVE it. It used to be
 * `required`, so the console had no way to say "stop forwarding" at all — the
 * only exit was a URL nobody listens on, which keeps failing deliveries against
 * a destination that is gone.
 *
 * `secret` is absent to keep the stored one, a string to replace it, and `null`
 * to remove it. The EMPTY STRING IS REFUSED here exactly as the gateway refuses
 * it: it used to mean "keep", which made an untouched password box and a
 * cleared one the same request. Clearing has its own spelling now, so the
 * ambiguity has nowhere left to live — and a caller that sends `""` is stating
 * something it cannot mean, which is worth an error rather than a guess.
 */
function validateSubscriberInput(input: unknown): SetSubscriberConfigInput & DashboardScopeInput {
  const record = inputRecord(input);
  if (record.url !== null && (typeof record.url !== "string" || record.url.trim() === "")) {
    throw new Error("url must be a non-empty string, or null to remove the target");
  }
  if (record.secret !== undefined && record.secret !== null && typeof record.secret !== "string") {
    throw new Error("secret must be a string, or null to remove it");
  }
  if (typeof record.secret === "string" && record.secret.trim() === "") {
    throw new Error("secret cannot be empty: pass null to remove it, or omit it to keep the stored one");
  }
  const wabaId = optionalWabaId(record.wabaId);
  const url = record.url === null ? null : (record.url as string).trim();
  const secret = typeof record.secret === "string" ? record.secret.trim() : record.secret;
  return {
    url,
    ...(secret === undefined ? {} : { secret }),
    ...(wabaId ? { wabaId } : {}),
  };
}

/**
 * The console's send validator — the strict one (the gateway re-checks the same
 * shapes as defense in depth, but this is where an operator's typing is turned
 * into a Meta-shaped request).
 *
 * `buttonParams` gets the same treatment as `bodyParams`: at most three
 * entries, an integer 0-based slot index within bounds, and a text value
 * without line breaks. Included only when non-empty, exactly like
 * `bodyParams`.
 *
 * `wabaId` and `phoneNumberId` are REQUIRED: a test send must never silently
 * fall back to "the account's first WABA". Which number the message leaves from
 * is the whole point of the exercise.
 *
 * Exported, unlike its siblings, so the refusal matrix can be asserted
 * directly — one call per rejected shape is cheaper than one route call each.
 * That is a convenience, not a necessity: the suite's shared
 * `@tanstack/react-start` fake DOES run `.validator()`
 * (tests/helpers/server-fn-mocks.ts), so route-level normalization is proven
 * through the route itself by the tripwire in tests/gateway.test.ts.
 */
export function validateSendTestInput(input: unknown): SendTemplateTestInput {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  if (typeof record.phoneNumberId !== "string" || !PHONE_NUMBER_ID_PATTERN.test(record.phoneNumberId.trim())) {
    throw new Error("phoneNumberId is required");
  }
  if (typeof record.to !== "string") throw new Error("recipient is required");
  // Operators paste numbers the way people write them: "+34 600-00 00 11",
  // "(600) 000 011". Strip the punctuation and the leading + and keep digits —
  // which is the only form the Cloud API accepts.
  const to = record.to.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!RECIPIENT_PATTERN.test(to)) {
    throw new Error("recipient must be 5 to 15 digits in international format");
  }
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
  const values = bodyParams.map((value) => {
    if (typeof value !== "string") throw new Error("template parameters must be strings");
    const text = value.trim();
    if (!text) throw new Error("every template parameter needs a value");
    if (text.length > MAX_BODY_PARAM_LENGTH) throw new Error("template parameter is too long");
    // Meta rejects newlines and tabs inside a text parameter outright, so this
    // is a refusal the operator can act on rather than a 132000 from Graph.
    if (/[\n\t]/.test(text)) throw new Error("template parameters cannot contain line breaks");
    return text;
  });
  const rawButtons = record.buttonParams;
  if (rawButtons !== undefined && !Array.isArray(rawButtons)) {
    throw new Error("buttonParams must be an array");
  }
  const buttonParams = (rawButtons ?? []) as unknown[];
  if (buttonParams.length > MAX_BUTTON_PARAMS) throw new Error("too many button parameters");
  const buttons = buttonParams.map((value) => {
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
    return { index: button.index, text };
  });
  return {
    wabaId,
    phoneNumberId: record.phoneNumberId.trim(),
    to,
    templateName: record.templateName.trim(),
    languageCode: record.languageCode.trim(),
    ...(values.length > 0 ? { bodyParams: values } : {}),
    ...(buttons.length > 0 ? { buttonParams: buttons } : {}),
  };
}

/**
 * The console's authoring validator — the strict one, and the place where the
 * agreement with the send surface is enforced on the SERVER rather than only in
 * the sheet.
 *
 * It runs the very `analyzeDraftBody` the form runs, so a request that skipped
 * the UI cannot author a body the "Send test" sheet would later refuse; the
 * gateway re-checks the same shapes and THROWS, which is only unreachable while
 * this stays the strict one.
 *
 * Widened to the footer and URL buttons: a static footer (no placeholders,
 * within Meta's ceiling), and up to three https URL buttons — a dynamic URL (a
 * `{{n}}` placeholder) REQUIRES its example URL, a static URL carries none.
 * The refused set is unchanged: AUTHENTICATION, media headers, quick-replies,
 * carousels and OTP/copy-code/flow buttons stay outside exactly as the send
 * sheet's analysis keeps them unbuildable.
 *
 * Examples are mandatory, one per `{{n}}`: Meta requires an example value for
 * every parameter, and they are what its reviewers read. Their character rules
 * are the send validator's, byte for byte — an example travels to Meta as
 * content exactly as a send parameter does.
 *
 * Exported for the same reason as {@link validateSendTestInput}: one call per
 * rejected shape is cheaper than one route call each.
 */
export function validateCreateTemplateInput(input: unknown): CreateTemplateInput {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
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
  const values = examples.map((value) => {
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
  const buttons = buttonList.map((value) => {
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
    if (/[\n\t]/.test(text) || /[\n\t]/.test(url)) {
      throw new Error("buttons cannot contain line breaks");
    }
    const dynamic = url.includes("{{");
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
    wabaId,
    name: record.name.trim(),
    language: record.language.trim(),
    category: record.category,
    bodyText,
    ...(values.length > 0 ? { bodyExamples: values } : {}),
    ...(footerRaw !== undefined ? { footerText: String(footerRaw).trim() } : {}),
    ...(buttons.length > 0 ? { buttons } : {}),
  };
}

/** One translation of one template, named by BOTH its name and its Graph id.
 * The id is required because the name-only Meta call deletes every language. */
export function validateDeleteTemplateInput(input: unknown): DeleteTemplateInput {
  const record = inputRecord(input);
  const wabaId = optionalWabaId(record.wabaId);
  if (!wabaId) throw new Error("wabaId is required");
  if (typeof record.name !== "string" || !TEMPLATE_NAME_PATTERN.test(record.name.trim())) {
    throw new Error("invalid template name");
  }
  if (typeof record.templateId !== "string" || !TEMPLATE_ID_PATTERN.test(record.templateId.trim())) {
    throw new Error("invalid template id");
  }
  return { wabaId, name: record.name.trim(), templateId: record.templateId.trim() };
}

function validateSetupInput(input: unknown): { name?: string } | undefined {
  if (input === undefined) return undefined;
  const record = inputRecord(input);
  if (record.name === undefined) return {};
  if (typeof record.name !== "string") throw new Error("name must be a string");
  const name = record.name.trim();
  if (name.length > 200) throw new Error("name must be at most 200 characters");
  return name ? { name } : {};
}

/**
 * Read the `GATEWAY` service binding and invoke the gateway's RPC entrypoint.
 *
 * `env.GATEWAY` is re-typed as a `Service` over the shared `GatewayApi` contract
 * in `src/env.d.ts` — the same interface the gateway's `GatewayRPC implements` —
 * so no cast is needed here. That declaration is the single type tying the two
 * Workers together. The runtime `if (!gateway)` guard still covers a genuinely
 * missing binding (e.g. running the dashboard without the gateway).
 */
async function withGateway<T>(
  fn: (gateway: GatewayApi) => Promise<T>,
  action?: GatewayAction,
): Promise<Result<T>> {
  const gateway = env.GATEWAY;
  if (!gateway) {
    return { ok: false, kind: "unreachable", error: "GATEWAY service binding is not configured" };
  }
  try {
    // The permission check runs INSIDE the boundary on purpose: an
    // authorization refusal must come back classified as one, not escape as a
    // thrown server-function error (or, worse, get reported as a dead gateway).
    if (action) await requireGatewayPermission(requestAuth(), getRequest(), action);
    return { ok: true, data: await fn(gateway) };
  } catch (err) {
    return classifyFailure(err);
  }
}

/**
 * Name the failure from the error's type (eccos-k5a).
 *
 * `ForbiddenError` and `UnauthorizedError` are raised by the identity plane
 * before the RPC is attempted, so they say nothing about the gateway; anything
 * else escaping the call is a transport or RPC failure, which is the only case
 * allowed to blame the service binding. `instanceof` is the discriminator, with
 * the class's own `name` brand as the fallback that survives a duplicated
 * module copy (bundler chunk, test mock) — never the message text.
 */
async function classifyFailure(err: unknown): Promise<Failure> {
  if (err instanceof UnauthorizedError || isNamed(err, "UnauthorizedError")) {
    return { ok: false, kind: "unauthenticated", error: message(err) };
  }
  if (err instanceof ForbiddenError || isNamed(err, "ForbiddenError")) {
    const reason = (err as ForbiddenError).reason ?? "other";
    if (reason === "select-organization") {
      // The remedy is the choice itself, so this one branch pays to fetch it.
      // A failure to list them degrades to the sentence without a picker,
      // never to a wrong cause.
      const organizations = await resolveMemberships(requestAuth(), getRequest().headers).catch(
        () => [] as Membership[],
      );
      return { ok: false, kind: "forbidden", reason, error: message(err), organizations };
    }
    return { ok: false, kind: "forbidden", reason, error: message(err) };
  }
  return { ok: false, kind: "unreachable", error: message(err) };
}

function isNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ResolvedScope = {
  wabaId: string;
  accountId: string;
  resources: AccountResources;
};

type ResolvedAccount = {
  accountId: string;
  resources: AccountResources;
};

/**
 * Resolve the Eccos account for the signed-in user's organization (contract §1):
 * session → membership → organization_accounts link → account. The link is the
 * server-owned mapping in the control plane; a pending/disabled/unknown link
 * fails closed. The org id is re-validated against membership inside
 * requirePermission before any RPC runs.
 */
async function resolveOrganizationAccount(
  gateway: GatewayApi,
): Promise<ResolvedAccount> {
  const organizationId = await requireGatewayPermission(requestAuth(), getRequest(), "view");
  let link = await gateway.getOrganizationAccountLink(organizationId);
  if (!link) {
    // Self-healing reconcile (contract §2): the organization exists in the
    // identity plane but predates its account link (e.g. created during the
    // cutover). The idempotent saga converges to exactly one account + one
    // active link and never issues an API key; verified callers only (a
    // gateway:view permission was already required above).
    // ensureOrganizationAccount always activates on create; "existing"
    // cannot occur here because the link was just read as absent.
    const ensured = await gateway.ensureOrganizationAccount(organizationId);
    link = { accountId: ensured.accountId, status: "active" };
  }
  if (link.status !== "active") {
    throw new Error("This organization is not linked to an Eccos account");
  }
  const resources = await gateway.listAccountResources(link.accountId);
  if (!resources.account) throw new Error(`Account "${link.accountId}" is not configured`);
  return { accountId: link.accountId, resources };
}

/**
 * Which provisioning statuses a server function is willing to work with.
 *
 * `"active"` is the default and the rule for the data plane. `"any"` is for the
 * WABA-LEVEL reads and writes — templates, subscriber config — that need only
 * the WABA id and its stored token, and are exactly what an operator prepares
 * on a connected account that is still waiting for its phone number.
 */
type ScopeMode = "active" | "any";

function resolveScopeFromAccount(
  account: ResolvedAccount,
  requestedWabaId?: string,
  rejectUnknown = false,
  mode: ScopeMode = "active",
): ResolvedScope {
  const requested = requestedWabaId?.trim() || undefined;
  const { accountId, resources } = account;
  const wabas = [...resources.wabas].sort((a, b) => a.wabaId.localeCompare(b.wabaId));
  const requestedIsOwned = requested ? wabas.some((waba) => waba.wabaId === requested) : false;
  if (requested && !requestedIsOwned && rejectUnknown) {
    throw new Error(`WABA "${requested}" is not owned by account "${accountId}"`);
  }
  // Unrequested selection prefers the first ACTIVE WABA rather than the first
  // by id. An account with one active and one pending WABA used to break on
  // every page whenever the pending one happened to sort first — the console
  // would resolve to a WABA it then refused, and report a working tenant as an
  // unreachable gateway. Falling back to `wabas[0]` when none is active keeps
  // the all-pending account's error wording exactly as it was.
  const defaultWaba = wabas.find((waba) => waba.status === "active") ?? wabas[0];
  const selectedWaba = requestedIsOwned ? wabas.find((waba) => waba.wabaId === requested) : defaultWaba;
  const wabaId = selectedWaba?.wabaId;
  if (!wabaId) throw new Error(`Account "${accountId}" has no registered WABAs`);
  if (mode === "any") return { wabaId, accountId, resources };
  // An EXPLICITLY requested pending/failed WABA still throws. (The resulting
  // `unreachable` title is a known misclassification of an operator's own
  // choice; it is out of scope here and never reached by default selection.)
  if (selectedWaba?.status === "pending") throw new Error(`WABA "${wabaId}" is still provisioning`);
  if (selectedWaba?.status === "failed") throw new Error(`WABA "${wabaId}" provisioning failed`);
  return { wabaId, accountId, resources };
}

async function resolveScope(
  gateway: GatewayApi,
  requestedWabaId?: string,
  rejectUnknown = false,
  mode: ScopeMode = "active",
): Promise<ResolvedScope> {
  const account = await resolveOrganizationAccount(gateway);
  return resolveScopeFromAccount(account, requestedWabaId, rejectUnknown, mode);
}

function dashboardScope(scope: ResolvedScope): DashboardScope {
  return {
    accountId: scope.accountId,
    selectedWabaId: scope.wabaId,
    resources: {
      ...scope.resources,
      keys: [...scope.resources.keys].sort((a, b) => a.keyId.localeCompare(b.keyId)),
      wabas: [...scope.resources.wabas]
        .sort((a, b) => a.wabaId.localeCompare(b.wabaId))
        .map((waba) => ({
          ...waba,
          phones: [...waba.phones].sort((a, b) => a.phoneNumberId.localeCompare(b.phoneNumberId)),
        })),
      phones: [...scope.resources.phones].sort(
        (a, b) => a.wabaId.localeCompare(b.wabaId) || a.phoneNumberId.localeCompare(b.phoneNumberId),
      ),
    },
  };
}

/** What a scoped server function needs from its caller. */
interface ScopedOptions {
  /** Permission the operation requires, checked inside the failure boundary. */
  action: GatewayAction;
  /** WABA the operator asked about; the account is never theirs to pick. */
  wabaId?: string;
  /** Refuse a WABA the account does not own instead of falling back to its first. */
  rejectUnknown?: boolean;
  /** Whether a not-yet-active WABA is acceptable. Defaults to `"active"`. */
  scope?: ScopeMode;
}

async function withScopedGateway<T>(
  options: ScopedOptions,
  fn: (gateway: GatewayApi, scope: ResolvedScope) => Promise<T>,
): Promise<Result<T>> {
  return withGateway(async (gateway) => {
    const scope = await resolveScope(
      gateway,
      options.wabaId,
      options.rejectUnknown ?? false,
      options.scope ?? "active",
    );
    return fn(gateway, scope);
  }, options.action);
}

/** Status page loader — kept returning `{ status }` for the existing route. */
export const getGatewayStatus = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    async ({ data }): Promise<GatewayStatusResult> => {
      const res = await withScopedGateway(
        { action: "view", wabaId: data?.wabaId },
        (gateway, scope) => gateway.getStatus(scope.wabaId, scope.accountId),
      );
      return res.ok ? { ok: true, status: res.data } : res;
    },
  );

export const getDashboardScope = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    ({ data }): Promise<Result<DashboardScope>> =>
      withScopedGateway({ action: "view", wabaId: data?.wabaId }, (_, scope) =>
        Promise.resolve(dashboardScope(scope)),
      ),
  );

export const getDashboardState = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    ({ data }): Promise<DashboardStateResult> =>
      withGateway(async (gateway) => {
        // First-run onboarding (before the permission check): a session with
        // zero organization memberships cannot resolve a tenant, so the caller
        // is routed to /onboarding instead of failing closed with a gateway
        // error that reads as an infrastructure outage.
        const auth = requestAuth();
        const request = getRequest();
        await requireAuthContext(auth, request);
        const memberships = await resolveMemberships(auth, request.headers);
        if (memberships.length === 0) {
          return { stage: "no-organization" };
        }
        await requireGatewayPermission(auth, request, "view");
        const account = await resolveOrganizationAccount(gateway);
        const wabas = [...account.resources.wabas].sort((a, b) => a.wabaId.localeCompare(b.wabaId));
        // "account-ready" means "there is no data plane to show yet", not "there
        // are no WABAs": a WABA still awaiting its phone number is connected but
        // has no Durable Object worth reading, and resolving a scope for it
        // would throw — which the boundary would then report as a dead gateway
        // on EVERY page, /numbers included, where the note explaining the state
        // lives. Both consumers of this stage (the __root redirect and
        // numbers.tsx) already do the right thing with resources present.
        if (wabas.every((waba) => waba.status !== "active")) {
          return { stage: "account-ready", resources: account.resources };
        }
        const scope = resolveScopeFromAccount(account, data?.wabaId);
        return {
          stage: "ready",
          status: await gateway.getStatus(scope.wabaId, scope.accountId),
          scope: dashboardScope(scope),
        };
      }),
  );

export const getDashboardOverview = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(
    ({ data }): Promise<DashboardOverviewResult> =>
      withScopedGateway({ action: "view", wabaId: data?.wabaId }, async (gateway, scope) => ({
        status: await gateway.getStatus(scope.wabaId, scope.accountId),
        scope: dashboardScope(scope),
      })),
  );

export const getAccountResources = createServerFn({ method: "GET" }).handler(
  (): Promise<Result<AccountResources>> =>
    withGateway(async (gateway) => {
      const account = await resolveOrganizationAccount(gateway);
      return account.resources;
    }, "view"),
);

/**
 * Where Meta's callback hands the operator back (eccos-5z9). Derived from the
 * request origin, which the server entry has already narrowed to the canonical
 * customer host (or localhost in dev) before routing — so this is console
 * configuration, not browser input. The gateway re-validates it anyway.
 */
export const CONNECT_RETURN_PATH = "/numbers";

function connectReturnTo(request: Request): string {
  return new URL(CONNECT_RETURN_PATH, new URL(request.url).origin).href;
}

export const startConnect = createServerFn({ method: "POST" }).handler(
  (): Promise<Result<ConnectStartResult>> =>
    withGateway(async (gateway) => {
      // Embedded Signup is an admin+ mutation (contract §4): step-up policy is
      // enforced by eccos-0x0.7; the account comes from the organization link.
      const actor = await requireActor("administer");
      const returnTo = connectReturnTo(getRequest());
      let link = await gateway.getOrganizationAccountLink(actor.organizationId);
      if (!link) {
        const ensured = await gateway.ensureOrganizationAccount(actor.organizationId);
        link = { accountId: ensured.accountId, status: "active" };
      }
      if (!link || link.status !== "active") {
        throw new Error("This organization is not linked to an Eccos account");
      }
      const result = await gateway.startConnectForAccountId(link.accountId, returnTo);
      auditEvent({
        action: "connect_start",
        actorUserId: actor.session.userId,
        organizationId: actor.organizationId,
        accountId: link.accountId,
        outcome: "success",
      });
      return result;
    }),
);

/**
 * The public Meta identifiers the Embedded Signup JavaScript SDK page needs.
 *
 * `null` means the SDK path is not configured, and that is a supported state
 * rather than an error: the Connect button falls back to the server-side OAuth
 * redirect, which is the flow that has always worked and the only one a
 * self-hoster without a console has. Neither value is a credential — Meta's own
 * implementation guide puts both in client-side JavaScript — but the route is
 * still session-gated, because who may connect a number is an authorization
 * question regardless of how public the identifiers are.
 */
export interface EmbeddedSignupConfig {
  appId: string;
  configId: string;
  graphVersion: string;
}

export const getEmbeddedSignupConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<EmbeddedSignupConfig | null>> => {
    try {
      await requireActor("administer");
      const appId = env.META_APP_ID?.trim();
      const configId = env.META_ES_CONFIG_ID?.trim();
      if (!appId || !configId) return { ok: true, data: null };
      return {
        ok: true,
        data: {
          appId,
          configId,
          // Must match the gateway's; the SDK only uses it for the API version
          // it would call with, which this flow never does.
          graphVersion: env.META_GRAPH_VERSION?.trim() || "v25.0",
        },
      };
    } catch (err) {
      return classifyFailure(err);
    }
  },
);

/**
 * Resolve the caller's Eccos account for an Embedded Signup mutation, creating
 * the link if this is the organization's first connection. Shared by
 * `startConnect` and the SDK exchange so the two cannot drift on who is allowed
 * to connect a number.
 */
async function connectActorAccount(
  gateway: GatewayApi,
): Promise<{ actor: ActorContext; accountId: string }> {
  const actor = await requireActor("administer");
  let link = await gateway.getOrganizationAccountLink(actor.organizationId);
  if (!link) {
    const ensured = await gateway.ensureOrganizationAccount(actor.organizationId);
    link = { accountId: ensured.accountId, status: "active" };
  }
  if (!link || link.status !== "active") {
    throw new Error("This organization is not linked to an Eccos account");
  }
  return { actor, accountId: link.accountId };
}

function validateConnectExchangeInput(input: unknown): {
  code: string;
  state: string;
  wabaId?: string;
} {
  const record = inputRecord(input);
  const code = record.code;
  if (typeof code !== "string" || code.trim() === "" || code.length > 4096) {
    throw new Error("code must be a non-empty string");
  }
  const state = record.state;
  if (typeof state !== "string" || state.trim() === "" || state.length > 512) {
    throw new Error("state must be a non-empty string");
  }
  const wabaId = optionalWabaId(record.wabaId);
  return { code: code.trim(), state: state.trim(), ...(wabaId ? { wabaId } : {}) };
}

/**
 * Finish Embedded Signup for a code the JavaScript SDK handed to the browser.
 *
 * This exists so the browser never needs an account API key. The page holds the
 * code for the length of one `fetch`; everything that can actually mint
 * credentials — the app secret, the token exchange, the registration — happens
 * behind the private service binding, reached only through this
 * session-authenticated route.
 *
 * Meta's code lives **30 seconds**, so this path stays deliberately short:
 * validate, resolve the account, forward. Nothing is queued or retried, because
 * a retry would arrive with an expired code and an already-consumed state.
 */
export const exchangeConnectCode = createServerFn({ method: "POST" })
  .validator(validateConnectExchangeInput)
  .handler(
    ({ data }): Promise<Result<ConnectExchangeResult>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await connectActorAccount(gateway);
        const result = await gateway.exchangeConnectCodeForAccountId(
          accountId,
          data.code,
          data.state,
          data.wabaId,
        );
        auditEvent({
          action: "connect_exchange",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          resource: result.ok
            ? { wabaId: result.waba_id, connected: result.connected.length }
            : { code: result.code },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.error }),
        });
        return result;
      }),
  );

/**
 * A Meta access token an operator pasted, and optionally the WABA they chose.
 *
 * The console's validator is the strict one — the gateway re-checks the same
 * shape and THROWS, which stays unreachable only while this holds. Printable
 * ASCII with no whitespace refuses the two pastes that actually happen: a whole
 * `curl` command, and a token that wrapped across lines in a terminal.
 *
 * It is a shape check and nothing more. Whether the token WORKS is a question
 * only Meta can answer, and the gateway asks it — no amount of validating here
 * can tell an own-app token from a customer's.
 *
 * Exported for the same reason as {@link validateSendTestInput}: one call per
 * rejected shape is cheaper than one route call each.
 *
 * `wabaId`, when present, is either a candidate the gateway offered or an id
 * the operator typed to answer `no_waba`; both are Meta ids, so both must be
 * digits.
 */
export function validateTokenConnectInput(input: unknown): { token: string; wabaId?: string } {
  const record = inputRecord(input);
  if (typeof record.token !== "string") throw new Error("token is required");
  const token = record.token.trim();
  if (!token) throw new Error("token is required");
  if (token.length < MIN_META_TOKEN_LENGTH || token.length > MAX_META_TOKEN_LENGTH) {
    throw new Error("that does not look like a Meta access token");
  }
  if (!META_TOKEN_PATTERN.test(token)) {
    throw new Error("paste only the token — no spaces, quotes, or line breaks");
  }
  const wabaId = typedWabaId(record.wabaId);
  return { token, ...(wabaId ? { wabaId } : {}) };
}

/**
 * Attach a WABA from a token the operator pasted (eccos-up9).
 *
 * `administer`, the same class as `startConnect` / `exchangeConnectCode` and
 * for a stronger reason than either: this action DEPOSITS a long-lived Meta
 * credential into tenant state. `configure` would let a template admin paste
 * tokens, which is the wrong side of the credentials line this codebase draws.
 *
 * ── WHERE THE TOKEN GOES ────────────────────────────────────────────────────
 * In through this POST body, once, over a session-authenticated route; across
 * the private `GATEWAY` binding, never public HTTP; sealed at rest by the
 * control plane. It touches no log line and no audit field — see the
 * `connect_token` doc comment in `./audit.ts`, and the audit record below,
 * which carries identifiers and a failure code only.
 */
export const connectWithToken = createServerFn({ method: "POST" })
  .validator(validateTokenConnectInput)
  .handler(
    ({ data }): Promise<Result<ManualConnectResult>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await connectActorAccount(gateway);
        const result = await gateway.connectWabaWithToken(accountId, data.token, data.wabaId);
        // NO token, and nothing derived from one. `candidates` is counted, not
        // listed, because the count is what makes the line legible; the WABA
        // id the operator named (if any) is recorded because a refusal is
        // about that id, and an id is an identifier, not a credential.
        auditEvent({
          action: "connect_token",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          resource: result.ok
            ? { wabaId: result.waba_id, connected: result.connected.length }
            : {
                code: result.code,
                candidates: result.candidates?.length ?? 0,
                ...(data.wabaId ? { wabaId: data.wabaId } : {}),
              },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.code }),
        });
        return result;
      }),
  );

function validateSessionEventInput(input: unknown): SessionEvent {
  const record = inputRecord(input);
  const event = record.event;
  if (typeof event !== "string" || event.trim() === "" || event.length > 128) {
    throw new Error("event must be a non-empty string");
  }
  const field = (
    key: "currentStep" | "errorCode" | "sessionId" | "wabaId" | "phoneNumberId",
  ): string | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length > 256) throw new Error(`${key} must be a string`);
    return value.trim() || undefined;
  };
  const currentStep = field("currentStep");
  const errorCode = field("errorCode");
  const sessionId = field("sessionId");
  const wabaId = field("wabaId");
  const phoneNumberId = field("phoneNumberId");
  return {
    event: event.trim(),
    ...(currentStep ? { currentStep } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(wabaId ? { wabaId } : {}),
    ...(phoneNumberId ? { phoneNumberId } : {}),
  };
}

/**
 * Record one Embedded Signup session event in the audit log.
 *
 * This is the whole of what session logging buys that the server side does not
 * already know: which screen a customer abandoned on, and the error code and
 * session id when they report an error from inside the flow. Both are
 * unobtainable any other way, and the session id is the first thing Meta
 * support asks for.
 *
 * It is telemetry, so it never fails the flow — the caller ignores the result.
 * The payload is re-validated here rather than trusted: it originates in a
 * `postMessage` from another window, and although the client parser checks the
 * origin, a server route must never depend on a client-side check.
 */
export const recordConnectSessionEvent = createServerFn({ method: "POST" })
  .validator(validateSessionEventInput)
  .handler(
    ({ data }): Promise<Result<{ recorded: true }>> =>
      withGateway(async (gateway) => {
        const { actor, accountId } = await connectActorAccount(gateway);
        auditEvent({
          action: "connect_session_event",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId,
          resource: {
            event: data.event,
            currentStep: data.currentStep ?? null,
            errorCode: data.errorCode ?? null,
            sessionId: data.sessionId ?? null,
            wabaId: data.wabaId ?? null,
          },
          outcome: data.errorCode ? "failed" : "success",
        });
        return { recorded: true as const };
      }),
  );

export const listDeliveries = createServerFn({ method: "GET" })
  .validator(validateDeliveryInput)
  .handler(
    ({ data }): Promise<Result<DeliveryRecord[]>> =>
      withScopedGateway({ action: "view", wabaId: data?.wabaId }, (gateway, scope) =>
        gateway.listDeliveries({ ...data, wabaId: scope.wabaId }, scope.accountId),
      ),
  );

export const listInbound = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<InboundRow[]>> =>
    withScopedGateway({ action: "view", wabaId: data?.wabaId }, (gateway, scope) =>
      gateway.listInbound({ wabaId: scope.wabaId }, scope.accountId),
    ),
  );

export const listOutbound = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<OutboundRow[]>> =>
    withScopedGateway({ action: "view", wabaId: data?.wabaId }, (gateway, scope) =>
      gateway.listOutbound({ wabaId: scope.wabaId }, scope.accountId),
    ),
  );

export const listTemplates = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<TemplatesResult>> =>
    withScopedGateway(
      // `scope: "any"`: listing templates needs the WABA id and its stored Meta
      // token, nothing from the data plane — so it works on a connected WABA
      // that is still waiting for its phone number.
      { action: "view", wabaId: data?.wabaId, scope: "any" },
      async (gateway, scope) =>
        (await gateway.listTemplates(scope.wabaId, 100, scope.accountId)) as TemplatesResult,
    ),
  );

export const retryDelivery = createServerFn({ method: "POST" })
  .validator(validateRetryInput)
  .handler(
    ({ data }): Promise<Result<{ ok: boolean; previousStatus: string | null }>> =>
      withScopedGateway(
        { action: "operate", wabaId: data.wabaId, rejectUnknown: true },
        (gateway, scope) => gateway.retryDelivery(data.id, scope.wabaId, scope.accountId),
      ),
  );

/**
 * Send one template message from the console ("Send test").
 *
 * `operate` (operator+), the same class as `retryDelivery`: it causes outbound
 * traffic on the tenant's behalf but changes no configuration and mints no
 * credentials. `viewer` is excluded because a send has external effect and
 * marginal cost; requiring `configure`/`administer` would be wrong the other
 * way, since an operator smoke-testing a template before a campaign is exactly
 * the persona, and forcing admin would push teams to over-grant admin.
 *
 * `withGateway` without an `action` plus `requireActor` inside is the
 * `startConnect`/`exchangeConnectCode` precedent for an audited mutation: one
 * permission check, with the actor available for the audit record.
 */
export const sendTemplateTest = createServerFn({ method: "POST" })
  .validator(validateSendTestInput)
  .handler(
    ({ data }): Promise<Result<SendTemplateTestResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("operate");
        const scope = await resolveScope(gateway, data.wabaId, true);
        const result = await gateway.sendTemplateTest(
          { ...data, wabaId: scope.wabaId },
          scope.accountId,
        );
        // No recipient, no parameter values — ever. See `SensitiveAction`'s
        // "template_test_send" doc comment for why the number stays out.
        auditEvent({
          action: "template_test_send",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId: scope.accountId,
          resource: {
            wabaId: scope.wabaId,
            phoneNumberId: data.phoneNumberId,
            template: data.templateName,
            language: data.languageCode,
            ...(result.ok ? { messageId: result.messageId } : {}),
          },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.code }),
        });
        return result;
      }),
  );

/**
 * Create one message template ("New template").
 *
 * `configure` (admin+), NOT `operate`. The line this codebase draws is: reads
 * are `view`, acts that cause traffic are `operate`, and acts that change
 * DURABLE TENANT STATE are `configure`. A template is durable state at Meta
 * under the business's name: it counts against the WABA's template quota,
 * a rejected one affects the business's review standing, and — because
 * deleting an approved template locks its name for 30 days — even cleanup is
 * consequential. Splitting create (`operate`) from delete (`configure`) was the
 * alternative, and it is an escalation trap: an operator could author a
 * mistake they then cannot remove.
 *
 * `scope: "any"` (the `listTemplates` precedent, not `sendTemplateTest`'s
 * active-only rule): creation is a WABA-level write that needs the WABA id and
 * its stored token, nothing from the data plane. An account whose number is
 * still provisioning is exactly the one preparing its templates — authoring
 * precedes provisioning.
 */
export const createTemplate = createServerFn({ method: "POST" })
  .validator(validateCreateTemplateInput)
  .handler(
    ({ data }): Promise<Result<CreateTemplateResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("configure");
        const scope = await resolveScope(gateway, data.wabaId, true, "any");
        const result = await gateway.createTemplate(
          { ...data, wabaId: scope.wabaId },
          scope.accountId,
        );
        // NO body text and NO example value — ever. See `SensitiveAction`'s
        // "template_create" doc comment: both are message content, and the
        // audit log is not retention- or erasure-governed, so anything content
        // shaped written here could never be erased again. The template NAME is
        // an identifier and is already precedented by `template_test_send`.
        auditEvent({
          action: "template_create",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId: scope.accountId,
          resource: {
            wabaId: scope.wabaId,
            template: data.name,
            language: data.language,
            category: data.category,
            ...(result.ok ? { templateId: result.id, status: result.status } : {}),
          },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.code }),
        });
        return result;
      }),
  );

/**
 * Delete ONE translation of a template.
 *
 * `configure` for the same reason as creation, and with more force: deleting an
 * APPROVED template blocks its name from reuse for 30 days, which is the most
 * durable consequence anything on this page has.
 */
export const deleteTemplate = createServerFn({ method: "POST" })
  .validator(validateDeleteTemplateInput)
  .handler(
    ({ data }): Promise<Result<DeleteTemplateResult>> =>
      withGateway(async (gateway) => {
        const actor = await requireActor("configure");
        const scope = await resolveScope(gateway, data.wabaId, true, "any");
        const result = await gateway.deleteTemplate(
          { ...data, wabaId: scope.wabaId },
          scope.accountId,
        );
        auditEvent({
          action: "template_delete",
          actorUserId: actor.session.userId,
          organizationId: actor.organizationId,
          accountId: scope.accountId,
          resource: {
            wabaId: scope.wabaId,
            template: data.name,
            templateId: data.templateId,
          },
          outcome: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { detail: result.code }),
        });
        return result;
      }),
  );

// --- Operator actions (webhooks page) ---

/** Read the current outbound-forwarding target. The secret is never exposed. */
export const getSubscriberConfig = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<SubscriberConfig>> =>
    // `scope: "any"`: the forwarding target is what an operator sets up BEFORE
    // any traffic arrives, so refusing to show it until a number exists gets
    // the order backwards.
    withScopedGateway({ action: "operate", wabaId: data?.wabaId, scope: "any" }, (gateway, scope) =>
      gateway.getSubscriberConfig(scope.wabaId, scope.accountId),
    ),
  );

/**
 * Whether a forwarding target exists — the one setup fact the root loader
 * cannot already see (`lib/setup-checklist.ts`).
 *
 * A BOOLEAN and not the config, on purpose: this rides every page load for the
 * sidebar checklist, and the URL itself is nobody's business outside the
 * Webhooks page. `action: "view"`, because seeing that a step is done is not
 * configuring anything.
 *
 * It answers `false` rather than a failure for an account that has no WABA yet:
 * there, "no forwarding target" is simply true, and a checklist row cannot show
 * a failure card. Nothing else consumes this, so nothing else loses a diagnosis.
 */
export const hasForwardingTarget = createServerFn({ method: "GET" })
  .validator(validateScopeInput)
  .handler(async ({ data }): Promise<boolean> => {
    const res = await withScopedGateway(
      { action: "view", wabaId: data?.wabaId, scope: "any" },
      async (gateway, scope) => {
        const config = await gateway.getSubscriberConfig(scope.wabaId, scope.accountId);
        return config.url !== null;
      },
    );
    return res.ok ? res.data : false;
  });

/** Rotate the forwarding target. `secret` is only sent when the operator sets it. */
export const setSubscriberConfig = createServerFn({ method: "POST" })
  .validator(validateSubscriberInput)
  .handler(
    ({ data }): Promise<Result<{ ok: true }>> =>
      withScopedGateway(
        // `scope: "any"`, for the same reason as the read: a subscriber URL
        // written in the awaiting-a-phone state survives provisioning, because
        // the saga's own `saveConfig` only ever writes META_*/CONNECTED_AT keys.
        { action: "configure", wabaId: data.wabaId, rejectUnknown: true, scope: "any" },
        (gateway, scope) => {
          const { wabaId: _wabaId, ...input } = data;
          return gateway.setSubscriberConfig(input, scope.wabaId, scope.accountId);
        },
      ),
  );

/**
 * Re-run the Meta webhook subscription handshake. Two layers: the outer
 * `Result` reports gateway reachability; the inner `ResubscribeResult` reports
 * whether Meta accepted the (re)subscription.
 */
export const resubscribe = createServerFn({ method: "POST" })
  .validator(validateScopeInput)
  .handler(({ data }): Promise<Result<ResubscribeResult>> =>
    withScopedGateway(
      { action: "configure", wabaId: data?.wabaId, rejectUnknown: true },
      (gateway, scope) => gateway.resubscribe(scope.wabaId, scope.accountId),
    ),
  );


/**
 * Re-run provisioning for one number the account owns (eccos-lpk).
 *
 * The connect callback normally leaves a number `active` before the operator
 * lands here, so this exists for the tail: a Meta hiccup left the row `pending`
 * and the operator should not have to sit through the five-minute cron without
 * a button. `withScopedGateway` is deliberately not used — it refuses a pending
 * WABA, which is the only kind worth re-checking. The account still comes from
 * the organization link and the WABA is re-checked against that account's own
 * registry before the RPC runs; the gateway verifies ownership again.
 */
export const recheckNumber = createServerFn({ method: "POST" })
  .validator(validateWabaInput)
  .handler(({ data }): Promise<Result<ReconcileWabaResult>> =>
    withGateway(async (gateway) => {
      const account = await resolveOrganizationAccount(gateway);
      if (!account.resources.wabas.some((waba) => waba.wabaId === data.wabaId)) {
        throw new Error(`WABA "${data.wabaId}" is not owned by account "${account.accountId}"`);
      }
      return gateway.reconcileWaba(data.wabaId, account.accountId);
    }, "configure"),
  );
