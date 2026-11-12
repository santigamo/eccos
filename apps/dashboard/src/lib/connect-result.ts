import type { ConnectExchangeResult, ConnectFailureCode } from "@eccos/gateway-contract";

/**
 * One sentence per failed exchange, in the console's own words. The gateway
 * sends a code, never a Graph error message: the wording is a product decision,
 * and a raw provider error has no business sitting in a URL.
 */
export const CONNECT_FAILURES: Record<ConnectFailureCode, string> = {
  state: "That connection attempt expired before Meta answered. Start it again.",
  denied: "Meta ended the connection before a number was attached. Nothing changed here.",
  owned: "That WhatsApp Business Account is already connected to another Eccos workspace.",
  no_waba: "That Meta login has no WhatsApp Business Account yet. Create one, then connect again.",
  subscription_required: "This workspace cannot add new numbers, so the new ones were left out.",
  // Also covers our own storage errors, so it does not blame Meta.
  failed: "The connection could not be completed. Try again.",
};

/** The same refusal on a console with billing on, where there is something to do about it. */
export const SUBSCRIPTION_REQUIRED_MESSAGE =
  "Adding a new number needs an active subscription, so the new ones were left out.";

/** Shown when the customer closes Meta's window without finishing. Not an error. */
export const CONNECT_CANCELLED_MESSAGE =
  "The Meta window was closed before a number was connected. Nothing changed. Start again when you are ready.";

/**
 * The browser refused Meta's window: `window.open` returned null. Chrome's
 * address bar shows a blocked-pop-up icon at that moment; the way out is to
 * allow pop-ups for this exact host, then click again.
 */
export function popupBlockedMessage(host: string): string {
  return `Your browser blocked Meta's window. Click the blocked pop-up icon at the right of the address bar (or open the lock icon, then Site settings), allow pop-ups for ${host}, then click again.`;
}

/**
 * The window opened (or we could not see it) but nothing has taken focus. This
 * is never a blocked verdict: a window behind this one looks the same.
 */
export function popupBehindMessage(host: string): string {
  return `Meta's window should be open and may be behind this one. If you cannot find it, allow pop-ups for ${host} (look for the pop-up icon in the address bar), then start again.`;
}

/**
 * `window.open` could not be observed, so nothing is known: not blocked, not
 * open. Says only what to check.
 */
export function popupUnknownMessage(host: string): string {
  return `If you do not see Meta's window, it may be behind this one or blocked. Allow pop-ups for ${host} (look for the pop-up icon in the address bar), then start again.`;
}

/** What the connect view does with an Embedded Signup exchange. */
export type ConnectVerdict =
  /**
   * Land on /numbers, where the real state shows. Never a retry: a second
   * Embedded Signup re-onboards the number and re-asks Meta for once-only
   * syncs, and a refused coexistence sync (the usual cause of failed
   * provisioning) is recovered by an operator from the row, not by the customer.
   */
  | {
      navigate: true;
      outcome: "ok" | "no_number" | "provisioning_failed";
      /** Accounts owned by another workspace that were left out. */
      skipped: number;
    }
  | { navigate: false; outcome: ConnectFailureCode; message: string };

/**
 * Failed provisioning is checked before an empty `connected` list so both
 * orderings of a bad result land the same way. A WABA with no phone number is
 * registered anyway; /numbers explains it, as the redirect path does.
 */
export function judgeExchange(result: ConnectExchangeResult): ConnectVerdict {
  if (!result.ok) {
    return { navigate: false, outcome: result.code, message: CONNECT_FAILURES[result.code] };
  }
  const outcome =
    result.status === "failed"
      ? "provisioning_failed"
      : result.connected.length === 0
        ? "no_number"
        : "ok";
  return { navigate: true, outcome, skipped: result.warnings?.length ?? 0 };
}

/** Where a landed exchange goes: the numbers page, flagging skipped accounts and refused new numbers. */
export function returnPathFor(base: string, skipped: number, subscriptionRequired = false): string {
  const params = [
    ...(skipped > 0 ? [`connectSkipped=${skipped}`] : []),
    ...(subscriptionRequired ? ["connectError=subscription_required"] : []),
  ];
  return params.length > 0 ? `${base}?${params.join("&")}` : base;
}

/**
 * The log line for an exchange, from the same verdict the console acts on, so
 * the two cannot drift: anything but a clean connect is `failed`.
 */
export function connectAudit(result: ConnectExchangeResult): {
  outcome: "success" | "failed";
  detail?: string;
} {
  const verdict = judgeExchange(result);
  if (verdict.outcome === "ok") return { outcome: "success" };
  return { outcome: "failed", detail: result.ok ? verdict.outcome : result.error };
}

/** Rounded so the timing says "how long" without being a fingerprint. */
export function secondsBucket(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return "<10s";
  if (s < 30) return "<30s";
  if (s < 120) return "<2m";
  if (s < 600) return "<10m";
  return "10m+";
}

/**
 * Calls `onSlow` unless this window is left within `ms`: Meta's popup takes
 * focus (`blur`), or opens as a tab and hides this page. It never says "blocked".
 */
export function watchPopup(onSlow: () => void, ms: number): () => void {
  const opened = () => {
    if (document.visibilityState === "hidden") stop();
  };
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener("blur", stop);
    document.removeEventListener("visibilitychange", opened);
  };
  const timer = setTimeout(() => {
    stop();
    onSlow();
  }, ms);
  window.addEventListener("blur", stop);
  document.addEventListener("visibilitychange", opened);
  return stop;
}
