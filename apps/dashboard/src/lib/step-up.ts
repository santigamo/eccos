import { authClient } from "../auth/auth-client";
import type { Failure } from "../server/gateway";

/** Where a step-up refusal is resolved, carrying the page to come back to. */
export function stepUpHref(reason: Failure["reason"], returnTo: string): string | null {
  const back = encodeURIComponent(returnTo);
  if (reason === "totp-required") return `/settings?redirect=${back}`;
  if (reason === "reauth-required") return `/signin?reauth=true&redirect=${back}`;
  return null;
}

export interface StepUpNavigation {
  here: () => string;
  assign: (href: string) => void;
  signOut: () => Promise<unknown>;
}

const browser: StepUpNavigation = {
  here: () => window.location.pathname + window.location.search,
  assign: (href) => window.location.assign(href),
  signOut: () => authClient.signOut(),
};

/**
 * Sends the operator to enroll or sign in again when a sensitive action was
 * refused for step-up, and reports whether it did. The destination explains
 * why and returns them to the page they were on.
 */
export function followStepUp(failure: Failure, nav: StepUpNavigation = browser): boolean {
  const href = stepUpHref(failure.reason, nav.here());
  if (!href) return false;
  if (failure.reason === "reauth-required") {
    // /signin bounces a signed-in visitor, so the stale session ends first.
    void nav
      .signOut()
      .catch(() => {})
      .finally(() => nav.assign(href));
  } else {
    nav.assign(href);
  }
  return true;
}
