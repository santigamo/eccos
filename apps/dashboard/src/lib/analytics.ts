/**
 * Umami analytics for the operator console (eccos-mlq0.2).
 *
 * OPT-IN, BY CONSTRUCTION. Every entry point here starts from
 * `analyticsConfigFromEnv`: with `ANALYTICS_SCRIPT_URL` or
 * `ANALYTICS_WEBSITE_ID` unset the function returns null, no script tag is
 * rendered, no global hook is installed and no event helper has a tracker to
 * call. That is the promise `docs/privacy.md` makes to a self-hoster, so the
 * empty case is the default rather than a special case.
 *
 * WHAT NEVER LEAVES THE BROWSER. Events carry enums and Meta/Better Auth codes
 * only — never an email, an organization name, a phone number or a WABA id. The
 * one identifier Umami knows is a HASHED user id (`analyticsUserId`), salted
 * with a fixed prefix so the same Better Auth id cannot be correlated with
 * another product's analytics.
 *
 * URLS ARE REDACTED, NOT DROPPED. The console addresses real state in the query
 * string — OAuth `state`/`code`, the Embedded Signup outcome, a sign-in
 * `redirect`, a `wabaId` scope — and a tracker that records them would put
 * tokens and tenant ids in a third-party dashboard. `redactTrackedUrl` keeps
 * the path and the marketing parameters (`utm_*`, which the landing hands us)
 * and strips the rest. It runs in `data-before-send`, Umami's own hook, so the
 * visitor's address bar is never rewritten.
 *
 * The module is runtime-agnostic: the parser, the hash and the redaction are
 * pure and unit-tested without a DOM (`tests/analytics.test.tsx`).
 */

import type { ConnectFailureCode } from "@eccos/gateway-contract";
import { isFinishEvent, type ConnectPath, type SessionEvent } from "./embedded-signup";

/** The Worker vars that switch analytics on. All empty ⇒ no tracker at all. */
export interface AnalyticsEnv {
  ANALYTICS_SCRIPT_URL?: string | undefined;
  ANALYTICS_WEBSITE_ID?: string | undefined;
  ANALYTICS_DOMAINS?: string | undefined;
  ANALYTICS_EXCLUDE_USER_IDS?: string | undefined;
}

/** Server-side configuration, including the raw ids that must never ship. */
export interface AnalyticsConfig {
  scriptUrl: string;
  websiteId: string;
  /** Exact hostnames the tracker accepts; Umami matches them literally. */
  domains: string;
  /**
   * Better Auth user ids whose traffic is not counted, and for whom the script
   * is not loaded at all (owner/devices). Compared server-side only.
   */
  excludeUserIds: ReadonlySet<string>;
}

/** What the browser receives: script placement plus the hashed identity. */
export interface AnalyticsClientConfig {
  scriptUrl: string;
  websiteId: string;
  domains: string;
  user: AnalyticsIdentity | null;
}

export interface AnalyticsIdentity {
  /** Hex SHA-256 of `eccos:` + user id, truncated to 16 chars. Opaque. */
  id: string;
  role: string | null;
  hasOrg: boolean;
}

/** The console is a `.chat` subdomain; a self-hoster overrides the var. */
export const DEFAULT_ANALYTICS_DOMAINS = "app.eccos.chat";

/** Name of the global `data-before-send` hook the tracker calls. */
export const ANALYTICS_BEFORE_SEND = "eccosAnalyticsBeforeSend";

/** Fixes the hash's namespace without carrying any of the id's material. */
const ANALYTICS_ID_PREFIX = "eccos:";

/**
 * Query parameters that never reach Umami: auth material, the redirected
 * outcome, and tenant/row addresses an operator's URL may carry.
 * Lowercase — lookups are case-insensitive.
 */
const REDACTED_PARAMS: ReadonlySet<string> = new Set([
  "state",
  "code",
  "error",
  "errorcode",
  "connecterror",
  "connectskipped",
  "redirect",
  "token",
  "invitation",
  "invitationid",
  // `/invitations?id=` — the invitation being accepted.
  "id",
  "wabaid",
  "email",
  "sessionid",
]);

/**
 * Catch-all for a parameter that names a secret in the future without being
 * added above. `utm_*` is exempt before this is consulted.
 */
const REDACTED_PATTERN = /token|secret|password|session|auth|invitation|redirect|grant|key/i;

const HAS_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

export function analyticsConfigFromEnv(env: AnalyticsEnv): AnalyticsConfig | null {
  const scriptUrl = env.ANALYTICS_SCRIPT_URL?.trim() ?? "";
  const websiteId = env.ANALYTICS_WEBSITE_ID?.trim() ?? "";
  if (!scriptUrl || !websiteId) return null;
  return {
    scriptUrl,
    websiteId,
    domains: env.ANALYTICS_DOMAINS?.trim() || DEFAULT_ANALYTICS_DOMAINS,
    excludeUserIds: parseExcludeUserIds(env.ANALYTICS_EXCLUDE_USER_IDS),
  };
}

/** Comma-separated Better Auth user ids; blank entries and stray spaces drop. */
export function parseExcludeUserIds(raw: string | undefined): ReadonlySet<string> {
  const ids = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return new Set(ids);
}

/**
 * Is this user opted out of analytics? An excluded user not only stops
 * counting: the server returns no config, so their browser never loads the
 * tracker (`getAnalyticsContext`).
 */
export function isAnalyticsExcluded(config: AnalyticsConfig, userId: string): boolean {
  return config.excludeUserIds.has(userId);
}

/**
 * An opaque analytics id for a session user: hex SHA-256 of `eccos:` + the
 * Better Auth id, truncated to 16 characters.
 *
 * The salt is what stops a Better Auth id from being recognised in the Umami
 * dashboard as the same string that appears in our D1, and 16 hex chars is
 * plenty for a per-user grouping while staying small in every payload.
 */
export async function analyticsUserId(userId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${ANALYTICS_ID_PREFIX}${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Strip stateful/secret query parameters from a URL before it is sent.
 *
 * Keeps the path, the fragment and every `utm_*` parameter (the landing's
 * attribution). Relative URLs stay relative and absolute ones stay absolute, so
 * the value can be written back into Umami's payload unchanged.
 */
export function redactTrackedUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input, "https://analytics.invalid");
  } catch {
    return input;
  }
  const keys: string[] = [];
  url.searchParams.forEach((_value, key) => keys.push(key));
  for (const key of keys) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("utm_")) continue;
    if (REDACTED_PARAMS.has(normalized) || REDACTED_PATTERN.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return HAS_PREFIX.test(input) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Redact `payload.url` and `payload.referrer`; anything else passes through.
 *
 * The referrer matters as much as the url: on an SPA navigation Umami reports
 * the PREVIOUS url as the referrer (origin-stripped), so a page left with
 * `?state=…&code=…` in the address bar would otherwise leak on the next one.
 */
export function sanitizeAnalyticsPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = { ...(payload as Record<string, unknown>) };
  for (const field of ["url", "referrer"] as const) {
    const value = record[field];
    if (typeof value === "string" && value) record[field] = redactTrackedUrl(value);
  }
  return record;
}

/**
 * The inline script rendered before the deferred tracker: the owner opt-out
 * (identical to the landing's `?nostats` switch) and the `data-before-send`
 * hook that redacts the url and referrer.
 *
 * It is a string, not a module import, because it must exist as a global before
 * Umami's deferred script evaluates — and it is built from the same constants
 * `redactTrackedUrl` uses, so the two cannot drift on what counts as sensitive.
 */
export function analyticsBootstrapScript(): string {
  const blocked = JSON.stringify(
    Object.fromEntries([...REDACTED_PARAMS].map((key) => [key, 1])),
  );
  return [
    "(function(){",
    // Same semantics as apps/site/src/layouts/SiteLayout.astro: `?nostats`
    // sets the tracker's own localStorage flag, `?nostats=0` clears it.
    'try{var m=/[?&]nostats(?:=([^&]*))?(?=&|$)/.exec(location.search);if(m){if(m[1]==="0"||m[1]==="false"){localStorage.removeItem("umami.disabled");console.info("[eccos] analytics re-enabled for this browser")}else{localStorage.setItem("umami.disabled","1");console.info("[eccos] analytics disabled for this browser")}}}catch(e){}',
    // `redact` mirrors `redactTrackedUrl`, including keeping a relative value
    // (Umami sends a same-origin referrer origin-stripped) relative.
    `try{var blocked=${blocked},pattern=/${REDACTED_PATTERN.source}/i,absolute=/${HAS_PREFIX.source}/i;`,
    'var redact=function(value){try{var url=new URL(value,location.href),keys=[];url.searchParams.forEach(function(_,key){keys.push(key)});for(var i=0;i<keys.length;i++){var key=keys[i],normalized=key.toLowerCase();if(normalized.indexOf("utm_")===0)continue;if(blocked[normalized]||pattern.test(key))url.searchParams.delete(key)}return absolute.test(value)?url.toString():url.pathname+url.search+url.hash}catch(e){return value}};',
    `window.${ANALYTICS_BEFORE_SEND}=function(type,payload){`,
    'if(!payload||typeof payload!=="object")return payload;',
    'if(typeof payload.url==="string"&&payload.url)payload.url=redact(payload.url);',
    'if(typeof payload.referrer==="string"&&payload.referrer)payload.referrer=redact(payload.referrer);',
    "return payload}}catch(e){}",
    "})();",
  ].join("");
}

/**
 * One tracker call, and never more than a no-op: a browser without the script
 * (self-host, `?nostats`, an ad blocker) must not break a form submit.
 */
export function track<K extends keyof AnalyticsEventMap>(
  name: K,
  data?: AnalyticsEventMap[K],
): void {
  if (typeof window === "undefined") return;
  try {
    window.umami?.track(name, data);
  } catch {
    // A tracker is never allowed to take a product flow down with it.
  }
}

/** The funnel this phase instruments. Properties are enums/codes only. */
export interface AnalyticsEventMap {
  signup_submit: undefined;
  signin_submit: undefined;
  connect_choice: { path: ConnectPath };
  es_popup_open: undefined;
  es_finish: undefined;
  es_cancel: { step?: string };
  es_error: { code?: string };
  connect_outcome: { result: "ok" | "skipped" | ConnectFailureCode };
}

/** Map one Meta Embedded Signup session event to the matching funnel event. */
export function trackSessionEvent(
  event: Pick<SessionEvent, "event" | "currentStep" | "errorCode">,
): void {
  if (isFinishEvent(event.event)) {
    track("es_finish");
    return;
  }
  if (event.event === "CANCEL") {
    track("es_cancel", event.currentStep ? { step: event.currentStep } : {});
    return;
  }
  if (event.event === "ERROR") {
    track("es_error", event.errorCode ? { code: event.errorCode } : {});
  }
}

/** Umami's tracker, as far as this app uses it. */
export interface UmamiTracker {
  track(name: string, data?: unknown): void;
  identify(id: string, data?: unknown): void;
}

declare global {
  interface Window {
    umami?: UmamiTracker;
    eccosAnalyticsBeforeSend?: unknown;
  }
}

/**
 * The tracker is `defer`red, so hydration may run before it exists. Poll
 * briefly rather than calling `umami.identify` on a global that is not there
 * yet. A document rendered without analytics has no before-send hook either
 * (the bootstrap installs it), and resolves at once instead of polling.
 */
export function whenUmamiReady(timeoutMs = 10_000): Promise<UmamiTracker | undefined> {
  if (typeof window === "undefined") return Promise.resolve(undefined);
  if (window.umami) return Promise.resolve(window.umami);
  if (!window.eccosAnalyticsBeforeSend) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const tracker = window.umami;
      if (tracker || Date.now() - started >= timeoutMs) {
        window.clearInterval(timer);
        resolve(tracker);
      }
    }, 100);
  });
}
