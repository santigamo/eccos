/**
 * Responses of the server entry's auth gate for anonymous requests (eccos-myfq).
 *
 * A 302 to /signin only works for a browser loading a page. A server-function
 * fetch or a crawler asking for text follows it with its own `Accept` header,
 * and TanStack Start answers a non-HTML page request with a 500. So:
 * - a page load gets the 302, carrying a bounce-back only to a known page;
 * - a server-function call gets a serialized router redirect, which the client
 *   follows with a full load of /signin, returning to the page that made it;
 * - anything else that cannot take HTML gets a 406 before it reaches the router.
 */

import { PUBLIC_PATHS, signInHref } from "./redirect-target";

const NO_STORE = { "cache-control": "private, no-store" };

/**
 * The page-level gate, in order: static assets pass, a request that cannot
 * take HTML gets a 406, an anonymous server-function call a serialized
 * redirect, an anonymous page load a 302, and a signed-in user is bounced off
 * the auth pages (except /reset-password). `undefined` lets the request through.
 * The session is read only once a check needs it.
 */
export async function authGate(
  request: Request,
  hasSession: () => Promise<boolean>,
): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/assets/")) return undefined;
  const serverFn = isServerFnPath(pathname);
  if (!serverFn && !acceptsHtml(request.headers.get("accept"))) return notAcceptable();
  const isPublic = PUBLIC_PATHS.has(pathname);
  const session = await hasSession();
  if (!session && !isPublic) return serverFn ? serverFnSignIn(request) : signInRedirect(request);
  if (session && isPublic && pathname !== "/reset-password") {
    return new Response(null, { status: 302, headers: { location: "/", ...NO_STORE } });
  }
  return undefined;
}

export function isServerFnPath(pathname: string): boolean {
  return pathname.startsWith("/_serverFn/");
}

/** Same test TanStack Start applies before rendering a page. */
export function acceptsHtml(accept: string | null): boolean {
  const parts = (accept || "*/*").split(",").map((part) => part.trim());
  return parts.some((part) => part.startsWith("*/*") || part.startsWith("text/html"));
}

export function signInRedirect(request: Request): Response {
  const url = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: { location: signInHref(`${url.pathname}${url.search}`), ...NO_STORE },
  });
}

/**
 * A server function called without a session. The bounce-back is the page the
 * call came from (its same-origin Referer), never the server function's URL.
 */
export function serverFnSignIn(request: Request): Response {
  const body = {
    isSerializedRedirect: true,
    href: signInHref(sameOriginReferer(request)),
    reloadDocument: true,
    statusCode: 307,
  };
  return Response.json(body, { status: 401, headers: NO_STORE });
}

export function notAcceptable(): Response {
  return new Response("Not Acceptable", { status: 406, headers: NO_STORE });
}

function sameOriginReferer(request: Request): string | undefined {
  const referer = request.headers.get("referer");
  if (!referer) return undefined;
  try {
    const from = new URL(referer);
    if (from.origin !== new URL(request.url).origin) return undefined;
    return `${from.pathname}${from.search}`;
  } catch {
    return undefined;
  }
}
