/**
 * Where an anonymous visitor goes back to after signing in (eccos-myfq).
 *
 * Only the console's own pages qualify: a server-function URL, an API path, a
 * static file or an unknown path is not somewhere to land after sign-in, and
 * an absolute or protocol-relative URL is an open redirect. Anything else is
 * dropped and the caller falls back to "/".
 */

/**
 * The app pages a sign-in may return to — every route in `routeTree.gen.ts`
 * except the public auth pages, which a signed-in user is bounced off anyway.
 * `tests/auth-pages.test.ts` fails if this drifts from the route tree.
 */
export const REDIRECTABLE_PAGES: ReadonlySet<string> = new Set([
  "/",
  "/conversations",
  "/deliveries",
  "/events",
  "/invitations",
  "/messages",
  "/numbers",
  "/numbers/attach-token",
  "/onboarding",
  "/settings",
  "/templates",
  "/webhooks",
  "/workspaces/new",
]);

export function safeRedirectTarget(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return undefined;
  if (value.includes("\\")) return undefined;
  // C0 controls and DEL, scanned by code unit: Biome forbids control
  // characters in a regex, and a scan states the intent just as well.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  const end = value.search(/[?#]/);
  const pathname = end === -1 ? value : value.slice(0, end);
  return REDIRECTABLE_PAGES.has(pathname) ? value : undefined;
}

/** The sign-in page, carrying `target` as its bounce-back only when it is safe. */
export function signInHref(target: string | undefined): string {
  const redirect = safeRedirectTarget(target);
  return redirect ? `/signin?redirect=${encodeURIComponent(redirect)}` : "/signin";
}
