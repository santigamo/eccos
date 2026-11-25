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

/** The coexistence screen where Meta refuses a number without enough Business app activity. */
export const QR_CODE_STEP = "WHATSAPP_BUSINESS_APP_ONBOARDING_QR_CODE";

const CANCELLED_AT_QR_MESSAGE =
  "Meta's window was closed at the QR code step. Nothing changed. If Meta said the number lacks activity, use it in the WhatsApp Business app for about a week, then try again.";

/** The Embedded Signup error codes the console explains, from Meta's Embedded Signup error table. */
export type SignupErrorCode =
  | "3441067"
  | "3441069"
  | "3441070"
  | "3441072"
  | "3441090"
  | "3441071"
  | "3441075"
  | "2655145"
  | "2655123"
  | "2655082"
  | "3441093"
  | "2494064";

/** A Meta signup error as the customer reads it: what happened, then what to do. */
export type SignupErrorCopy = { title: string; body: string };

const PAGE_LINKED: SignupErrorCopy = {
  title: "A Facebook Page is linked to this number",
  body: "In Meta Business Suite, remove the Page under Settings, Accounts, Pages, or use another number.",
};

export const SIGNUP_ERRORS: Record<SignupErrorCode, SignupErrorCopy> = {
  "3441067": {
    title: "Another business portfolio holds this number",
    body: "Usually your previous WhatsApp provider. Ask them to release the number, then start again.",
  },
  "3441069": {
    title: "This number is on the regular WhatsApp app",
    body: "Move it to the WhatsApp Business app and choose the Business app option, or use another number.",
  },
  "3441070": {
    title: "This number is in use on WhatsApp",
    body: "If it is on the Business app, start again with the Business app option. Otherwise use another number, or delete its WhatsApp account first.",
  },
  "3441072": {
    title: "This number is on the WhatsApp Business app",
    body: "Start again and choose the Business app option, or use a number that is not on the app.",
  },
  "3441090": {
    title: "Another account in your portfolio holds this number",
    body: "Remove it from that WhatsApp Business account in WhatsApp Manager, then start again.",
  },
  "3441071": {
    title: "Your Facebook account needs two-factor authentication",
    body: "The portfolio that owns this number requires it. Turn it on in Facebook's security settings, then start again.",
  },
  "3441075": {
    title: "Two-step verification is on for this number",
    body: "This is the number's WhatsApp PIN, not your Facebook login. Turn it off, then start again.",
  },
  "2655145": {
    title: "Meta has restricted your Facebook account",
    body: "Review the restriction in Meta's Business Support Home, or ask someone else in your business to connect the number.",
  },
  "2655123": PAGE_LINKED,
  "2655082": PAGE_LINKED,
  "3441093": {
    title: "This number is still being disconnected",
    body: "That can take from a few minutes to more than a day. Try again later, or use another number.",
  },
  "2494064": {
    title: "This number is registered elsewhere on WhatsApp",
    body: "It may be on the WhatsApp app or with another API provider. Remove it there first, or use another number.",
  },
};

export const UNKNOWN_SIGNUP_ERROR_TITLE = "Meta didn't connect the number";

export function isSignupErrorCode(code: string | undefined): code is SignupErrorCode {
  return code !== undefined && Object.hasOwn(SIGNUP_ERRORS, code);
}

/** The neutral notice for a window closed with no error, worded for the screen it was closed on. */
export function connectCancelledMessage(step?: string): string {
  return step === QR_CODE_STEP ? CANCELLED_AT_QR_MESSAGE : CONNECT_CANCELLED_MESSAGE;
}

/** An error Meta's window reported, with its references: the session id is what Meta's support asks for. */
export type ReportedSignupError = SignupErrorCopy & { refs: string };

export function signupErrorRefs(code: string, sessionId?: string): string {
  return sessionId ? `Meta error ${code} · session ${sessionId}` : `Meta error ${code}`;
}

/** Null when Meta reported no code: that close is a plain cancel. */
export function reportedSignupError(
  step?: string,
  error?: { code?: string; sessionId?: string },
): ReportedSignupError | null {
  const code = error?.code;
  if (!code) return null;
  const copy = isSignupErrorCode(code)
    ? SIGNUP_ERRORS[code]
    : { title: UNKNOWN_SIGNUP_ERROR_TITLE, body: connectCancelledMessage(step) };
  return { ...copy, refs: signupErrorRefs(code, error.sessionId) };
}

/**
 * The browser refused Meta's window: `window.open` returned null. Chrome's
 * address bar shows a blocked-pop-up icon at that moment; the way out is to
 * allow pop-ups for this exact host, then click again.
 */
export function popupBlockedMessage(host: string): string {
  return `Your browser blocked Meta's window. Click the blocked pop-up icon at the right of the address bar (or open the lock icon, then Site settings), allow pop-ups for ${host}, then click again.`;
}

/**
 * Shown when nothing took focus after Meta's window should have opened. A
 * window behind this one is the likely case, so it comes first; a blocked one
 * looks the same and `window.open` is not always observable.
 */
export function popupHintMessage(host: string): string {
  return `Don't see Meta's window? It may be behind this one. If nothing opened, allow pop-ups for ${host} and start again.`;
}

/** Shown when Meta's window returns a code but the handoff behind it never existed. */
export const CONNECT_NOT_PREPARED = "The connection could not be prepared. Close Meta's window and start again.";

/** Appended when the handoff fails while Meta's window is already open. */
export const CONNECT_CLOSE_AND_RETRY = "Close Meta's window and try again.";

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
 * For a window we hold: after `ms`, calls `onBehind` if it is still open and
 * this page still has focus, which means it opened behind this one.
 */
export function watchWindow(popup: Pick<Window, "closed">, onBehind: () => void, ms: number): () => void {
  const timer = setTimeout(() => {
    if (!popup.closed && document.hasFocus()) onBehind();
  }, ms);
  return () => clearTimeout(timer);
}

/**
 * For a window we cannot see: calls `onSlow` unless this window is left within `ms`: Meta's popup takes
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
