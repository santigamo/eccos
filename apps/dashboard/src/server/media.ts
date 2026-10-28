import type { GatewayApi, MediaObject, MediaRange } from "@eccos/gateway-contract";
import { UnauthorizedError } from "../auth/session";
import { ForbiddenError } from "../auth/tenant";

/**
 * `/media/<wabaId>/<mediaId>`: the one URL the inbox puts in `<img>`, `<audio>`,
 * `<video>` and `<a>` tags. It is served by the dashboard's own origin, behind the
 * same session and workspace checks as every server function, never as a public
 * bucket URL.
 */
export const MEDIA_ROUTE = /^\/media\/([A-Za-z0-9_-]{1,64})\/(\d{1,32})$/;

/** The WABA and media id of a media path, or null when the path is not a media path. */
export function parseMediaPath(pathname: string): { wabaId: string; mediaId: string } | null {
  const match = MEDIA_ROUTE.exec(pathname);
  if (!match) return null;
  const [, wabaId = "", mediaId = ""] = match;
  return { wabaId, mediaId };
}

/** How long the browser may keep a media object. Private: never a shared cache. */
const CACHE_CONTROL = "private, max-age=300";

export interface MediaRouteDeps {
  /** Resolves the signed-in organization, or throws UnauthorizedError / ForbiddenError. */
  organizationFor(request: Request): Promise<string>;
  gateway: GatewayApi;
}

/**
 * Streams one stored media object to a member of the workspace that owns its WABA.
 * Anything the caller may not see is a 404, including a WABA of another workspace,
 * so the route never confirms that another workspace's media id exists.
 *
 * Safari plays video only from a server that answers `Range`, so a ranged GET is
 * a 206 and HEAD returns the headers alone.
 */
export async function serveMedia(
  request: Request,
  deps: MediaRouteDeps,
  wabaId: string,
  mediaId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, { allow: "GET, HEAD" });
  try {
    const organizationId = await deps.organizationFor(request);
    const link = await deps.gateway.getOrganizationAccountLink(organizationId);
    if (!link || link.status !== "active") return plain(404);
    const resources = await deps.gateway.listAccountResources(link.accountId);
    if (!resources.wabas.some((waba) => waba.wabaId === wabaId)) return plain(404);
    const range = parseRange(request.headers.get("range"));
    const media = await deps.gateway.getMedia({ wabaId, mediaId, range }, link.accountId);
    return media ? mediaResponse(media, request.method) : plain(404);
  } catch (error) {
    if (error instanceof UnauthorizedError) return plain(401);
    if (error instanceof ForbiddenError) return plain(403);
    return plain(503);
  }
}

/**
 * The one byte range a `Range` header asks for, as R2 takes it. A header this route
 * does not read (another unit, several ranges, a malformed value) is ignored, which
 * sends the whole object.
 */
export function parseRange(header: string | null): MediaRange | undefined {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match) return undefined;
  const [, start = "", end = ""] = match;
  if (start === "") return end === "" ? undefined : { suffix: Number(end) };
  const offset = Number(start);
  if (end === "") return { offset };
  const last = Number(end);
  return last < offset ? undefined : { offset, length: last - offset + 1 };
}

/**
 * Images, audio and video play or show in place. Anything else (a PDF, a
 * spreadsheet, an SVG, which can carry script) downloads: a document opened inline
 * is a document the browser may render as a page on this origin.
 */
export function dispositionFor(contentType: string): "inline" | "attachment" {
  if (/^image\/svg\+xml(\s|;|$)/i.test(contentType)) return "attachment";
  return /^(image|audio|video)\//i.test(contentType) ? "inline" : "attachment";
}

function mediaResponse(media: MediaObject, method: string): Response {
  const partial = media.range;
  const length = partial ? partial.length : media.size;
  const headers: Record<string, string> = {
    "content-type": media.contentType,
    "content-length": String(length),
    "content-disposition": dispositionFor(media.contentType),
    "accept-ranges": "bytes",
    "cache-control": CACHE_CONTROL,
    "x-content-type-options": "nosniff",
    // A document rendered inline must not run script on this origin.
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (partial) {
    headers["content-range"] = `bytes ${partial.offset}-${partial.offset + partial.length - 1}/${media.size}`;
  }
  if (method === "HEAD") {
    void media.body.cancel();
    return new Response(null, { status: partial ? 206 : 200, headers });
  }
  return new Response(media.body, { status: partial ? 206 : 200, headers });
}

const STATUS_TEXT: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  405: "Method not allowed",
  503: "Unavailable",
};

function plain(status: number, extra: Record<string, string> = {}): Response {
  return new Response(STATUS_TEXT[status], {
    status,
    headers: { "cache-control": "private, no-store", ...extra },
  });
}
