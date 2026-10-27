/**
 * Browser side of the opt-in Umami integration (eccos-mlq0.2). Events carry
 * enums and Meta codes only; the one identifier Umami sees is a hashed user id.
 */

import type { ConnectFailureCode } from "@eccos/gateway-contract";
import { isFinishEvent, type ConnectPath, type SessionEvent } from "./embedded-signup";

/** What the document needs to load the tracker. Null config ⇒ analytics off. */
export interface AnalyticsConfig {
  scriptUrl: string;
  websiteId: string;
  domains: string;
  userId: string | null;
}

export const BEFORE_SEND_HOOK = "eccosAnalyticsBeforeSend";

/**
 * Installs the `?nostats` owner opt-out and the `data-before-send` hook.
 *
 * It runs inline before the deferred tracker, serialized with `toString()`, so
 * it must not reference anything outside its own body.
 */
export function installAnalyticsHooks(win: Window, hook: string): void {
  try {
    const nostats = /[?&]nostats(?:=([^&]*))?(?=&|$)/.exec(win.location.search);
    if (nostats?.[1] === "0" || nostats?.[1] === "false") win.localStorage.removeItem("umami.disabled");
    else if (nostats) win.localStorage.setItem("umami.disabled", "1");
  } catch {}

  // Every query parameter in the console is state (OAuth codes, tokens, tenant
  // ids); only the landing's utm_* attribution is worth sending.
  const keepUtmOnly = (value: string): string => {
    try {
      const url = new URL(value, win.location.href);
      for (const key of [...url.searchParams.keys()]) {
        if (!key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
      }
      return /^[a-z][a-z\d+.-]*:/i.test(value) ? url.href : url.pathname + url.search + url.hash;
    } catch {
      return value;
    }
  };

  // Umami sends the previous SPA url as the referrer, so it is cleaned too.
  (win as unknown as Record<string, unknown>)[hook] = (
    _type: string,
    payload: Record<string, unknown> | null,
  ) => {
    for (const field of ["url", "referrer"]) {
      const value = payload?.[field];
      if (payload && typeof value === "string" && value) payload[field] = keepUtmOnly(value);
    }
    return payload;
  };
}

export function analyticsBootstrapScript(): string {
  return `(${installAnalyticsHooks.toString()})(window, ${JSON.stringify(BEFORE_SEND_HOOK)});`;
}

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

/** A no-op without a tracker (self-host, `?nostats`, ad blocker); never throws. */
export function track<K extends keyof AnalyticsEventMap>(name: K, data?: AnalyticsEventMap[K]): void {
  if (typeof window === "undefined") return;
  try {
    window.umami?.track(name, data);
  } catch {}
}

export function trackSessionEvent(
  event: Pick<SessionEvent, "event" | "currentStep" | "errorCode">,
): void {
  if (isFinishEvent(event.event)) track("es_finish");
  else if (event.event === "CANCEL") track("es_cancel", event.currentStep ? { step: event.currentStep } : {});
  else if (event.event === "ERROR") track("es_error", event.errorCode ? { code: event.errorCode } : {});
}

export interface UmamiTracker {
  track(name: string, data?: unknown): void;
  identify(id: string, data?: unknown): void;
}

declare global {
  interface Window {
    umami?: UmamiTracker;
  }
}

/**
 * The tracker is deferred, so it may not exist yet when React runs. Resolves
 * at once when the document was rendered without analytics (no hook installed).
 */
export function whenUmamiReady(timeoutMs = 10_000): Promise<UmamiTracker | undefined> {
  if (typeof window === "undefined") return Promise.resolve(undefined);
  if (window.umami) return Promise.resolve(window.umami);
  if (!(BEFORE_SEND_HOOK in window)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (window.umami || Date.now() - started >= timeoutMs) {
        window.clearInterval(timer);
        resolve(window.umami);
      }
    }, 100);
  });
}
