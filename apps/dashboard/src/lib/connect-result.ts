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
  subscription_required: "Adding a number needs an active subscription. Start one in Settings, then connect again.",
  // Also covers our own storage errors, so it does not blame Meta.
  failed: "The connection could not be completed. Try again.",
};

/** Shown when the customer closes Meta's window without finishing. Not an error. */
export const CONNECT_CANCELLED_MESSAGE =
  "The Meta window was closed before a number was connected. Nothing changed. Start again when you are ready.";

/** Meta's SDK never calls back when the browser blocks its popup. */
export const CONNECT_POPUP_BLOCKED_MESSAGE =
  "Meta's window did not open. Allow pop-ups for this site, then start again.";

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

/** Where a landed exchange goes: the numbers page, flagging skipped accounts. */
export function returnPathFor(base: string, skipped: number): string {
  return skipped > 0 ? `${base}?connectSkipped=${skipped}` : base;
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

/** A handoff is reused only if its state still has this long to live. */
export const HANDOFF_MIN_REMAINING_MS = 25 * 60_000;

export function handoffUsable(expiresAt: number, now: number): boolean {
  return expiresAt - now >= HANDOFF_MIN_REMAINING_MS;
}

/**
 * Calls `onBlocked` unless this window is left within `ms`: Meta's popup takes
 * focus (`blur`), or opens as a tab and hides this page.
 */
export function watchPopup(onBlocked: () => void, ms: number): () => void {
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
    onBlocked();
  }, ms);
  window.addEventListener("blur", stop);
  document.addEventListener("visibilitychange", opened);
  return stop;
}
