/**
 * Size limits on the OAuth endpoints anyone may call without a session
 * (contract §9): `oauth2/register`, `oauth2/token` and `oauth2/revoke`.
 *
 * Registration is anonymous and every accepted call stores a client row, so
 * the bytes one caller can persist are bounded here, before Better Auth parses
 * anything: the body is read as a stream, at most `OAUTH_BODY_LIMIT` bytes of
 * it are kept, and a longer one is refused, whatever `Content-Length`
 * claims. The metadata fields the `oauthClient` row keeps are then held to
 * the lengths in auth/client-metadata-limits.ts. A legitimate registration,
 * code exchange or revocation is well under 2 KiB.
 * Refusals use the endpoint's own error shape: RFC 7591 §3.2.2 for
 * registration, RFC 6749 §5.2 `invalid_request` for the other two.
 */

import { CLIENT_METADATA_MAX_BYTES, clientMetadataRefusal } from "../auth/client-metadata-limits";

export const OAUTH_BODY_LIMIT = CLIENT_METADATA_MAX_BYTES;

const LIMITED_PATHS = new Set(["/api/auth/oauth2/register", "/api/auth/oauth2/token", "/api/auth/oauth2/revoke"]);
const REGISTER_PATH = "/api/auth/oauth2/register";

function refusal(error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

/**
 * The body, or undefined when it passes the cap. The bytes are counted as they
 * arrive, whatever Content-Length says. Past the cap the rest is read and
 * dropped, never kept: answering before the upload ends makes the Workers
 * runtime abandon the request, and the caller sees a 503 instead of the 400.
 */
async function readCapped(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size <= OAUTH_BODY_LIMIT) chunks.push(value);
  }
  if (size > OAUTH_BODY_LIMIT) return undefined;
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function registrationRefusal(body: Uint8Array<ArrayBuffer>): Response | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
  const refused = clientMetadataRefusal(parsed);
  return refused && refusal(refused.error, refused.description);
}

/**
 * The request with its body read whole, or the refusal. Any other path, and a
 * request without a body, passes through untouched.
 */
export async function oauthRequestWithinLimits(request: Request, pathname: string): Promise<Request | Response> {
  if (!LIMITED_PATHS.has(pathname) || request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return request;
  }
  const isRegistration = pathname === REGISTER_PATH;
  const body = await readCapped(request);
  if (!body) {
    return isRegistration
      ? refusal("invalid_client_metadata", `The registration request is larger than ${OAUTH_BODY_LIMIT} bytes`)
      : refusal("invalid_request", `The request is larger than ${OAUTH_BODY_LIMIT} bytes`);
  }
  if (isRegistration) {
    const refused = registrationRefusal(body);
    if (refused) return refused;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
}
