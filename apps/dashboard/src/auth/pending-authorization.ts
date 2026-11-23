/**
 * The authorization a page was opened for, if any.
 *
 * Better Auth sends a person without a session from `/api/auth/oauth2/authorize`
 * to `/signin` (or `/signup`) with the authorization request signed into the
 * query: `sig`, the `ba_param` list of signed names, and those names. Sending
 * that query back to the authorize endpoint resumes the authorization once the
 * person has a session (design §3.5, §8.1). Only the signed parameters are
 * kept, as `oauthProviderClient` does; a page's own `redirect` is not part of it.
 */

/** The console's own steps inside an authorization: they need a session, never a workspace. */
export const OAUTH_PAGES: ReadonlySet<string> = new Set(["/oauth/workspace", "/oauth/consent"]);

function signedQuery(search: string): URLSearchParams | undefined {
  const params = new URLSearchParams(search);
  const signed = new Set(params.getAll("ba_param"));
  if (!params.has("sig") || signed.size === 0) return undefined;
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "sig" || key === "ba_param" || signed.has(key)) query.append(key, value);
  }
  return query;
}

export function pendingAuthorizationURL(search: string): string | undefined {
  const query = signedQuery(search);
  return query ? `/api/auth/oauth2/authorize?${query}` : undefined;
}

/** `href` with the pending authorization added, so moving between sign-in and sign-up keeps it. */
export function withPendingAuthorization(href: string, search: string): string {
  const query = signedQuery(search);
  if (!query) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${query}`;
}
