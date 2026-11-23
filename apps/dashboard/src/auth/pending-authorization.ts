/**
 * The authorization a sign-in or sign-up page was opened for, if any.
 *
 * Better Auth sends a person without a session from `/api/auth/oauth2/authorize`
 * to `/signin` (or `/signup`) with the authorization request signed into the
 * query: `sig`, the `ba_param` list of signed names, and those names. Sending
 * that query back to the authorize endpoint resumes the authorization once the
 * person has a session (design §3.5, §8.1). Only the signed parameters are
 * kept, as `oauthProviderClient` does; a page's own `redirect` is not part of it.
 */
export function pendingAuthorizationURL(search: string): string | undefined {
  const params = new URLSearchParams(search);
  const signed = new Set(params.getAll("ba_param"));
  if (!params.has("sig") || signed.size === 0) return undefined;
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "sig" || key === "ba_param" || signed.has(key)) query.append(key, value);
  }
  return `/api/auth/oauth2/authorize?${query}`;
}
