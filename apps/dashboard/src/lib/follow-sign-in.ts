import { isRedirect } from "@tanstack/react-router";

type Assign = (href: string) => void;

/**
 * A server function called from an event handler on an expired session throws
 * the gate's sign-in redirect (auth/page-gate.ts) instead of returning. A
 * catch block calls this first: it follows the redirect with a full load and
 * returns true, so the handler stops instead of showing it as an error.
 */
export function followSignIn(
  err: unknown,
  assign: Assign = (href) => window.location.assign(href),
): boolean {
  if (!isRedirect(err)) return false;
  assign(err.options.href ?? "/signin");
  return true;
}

/**
 * The net for handlers that do not catch: an unhandled sign-in redirect is
 * followed instead of surfacing as an unhandled rejection.
 */
export function watchUnhandledSignIn(
  win: Pick<Window, "addEventListener" | "removeEventListener">,
  assign?: Assign,
): () => void {
  const onRejection = (event: PromiseRejectionEvent) => {
    if (followSignIn(event.reason, assign)) event.preventDefault();
  };
  win.addEventListener("unhandledrejection", onRejection);
  return () => win.removeEventListener("unhandledrejection", onRejection);
}
