import { putMedia } from "./media-store";

/** Meta's largest media is a document at 100 MB. A bigger file is refused before any byte is read. */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const GRAPH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Graph subcode for "object does not exist", which is what an expired media id returns. */
const GRAPH_SUBCODE_NONEXISTENT = 33;
/** Graph code for an OAuth failure: the token is expired, revoked, or lacks the permission. */
const GRAPH_CODE_OAUTH = 190;

/** Retrying cannot succeed: Meta no longer has the id, or the file is over the limit. */
export class MediaPermanentError extends Error {
  override name = "MediaPermanentError";
}

/** Meta rejected the WABA's token. Nothing is wrong with the media, so no attempt is counted:
 * the caller waits and retries once the token is fixed. */
export class MediaTokenError extends Error {
  override name = "MediaTokenError";
}

export interface DownloadMetaMediaInput {
  bucket: R2Bucket;
  wabaId: string;
  mediaId: string;
  token: string;
  graphVersion: string;
  fetch?: typeof fetch;
}

export interface DownloadedMedia {
  size: number;
  contentType: string;
  sha256: string | null;
}

interface MetaMediaInfo {
  url: string;
  mimeType: string;
  sha256: string | undefined;
  size: number;
}

/**
 * Downloads one WhatsApp media object into R2 in two Graph steps: the id is
 * exchanged for a short-lived CDN URL (about five minutes), then the bytes are
 * fetched with the same token. The body is streamed into R2 with a known length
 * and Meta's SHA-256, so R2 itself rejects a truncated or altered file and the
 * bytes never sit in Worker memory.
 *
 * Throws {@link MediaPermanentError} when retrying cannot help, and
 * {@link MediaTokenError} when the token is rejected; any other error is transient
 * and the caller retries with backoff.
 */
export async function downloadMetaMedia(input: DownloadMetaMediaInput): Promise<DownloadedMedia> {
  const { bucket, wabaId, mediaId, token, graphVersion } = input;
  const send = input.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const headers = { authorization: `Bearer ${token}` };

  const lookup = await send(`https://graph.facebook.com/${graphVersion}/${mediaId}`, {
    headers,
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  if (!lookup.ok) {
    const { code, subcode } = await graphError(lookup);
    if (lookup.status === 404 || subcode === GRAPH_SUBCODE_NONEXISTENT) {
      throw new MediaPermanentError(`Meta no longer has media ${mediaId}`);
    }
    if (lookup.status === 401 || code === GRAPH_CODE_OAUTH) {
      throw new MediaTokenError(`Meta rejected the token for media ${mediaId}`);
    }
    throw new Error(`media lookup failed with ${lookup.status}`);
  }
  const info = parseMediaInfo(await lookup.json());
  if (info.size > MAX_MEDIA_BYTES) {
    throw new MediaPermanentError(`media is ${info.size} bytes, over the ${MAX_MEDIA_BYTES} byte limit`);
  }

  const download = await send(info.url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!download.ok || !download.body) throw new Error(`media download failed with ${download.status}`);

  const { readable, writable } = new FixedLengthStream(info.size);
  await Promise.all([
    putMedia(bucket, {
      wabaId,
      mediaId,
      body: readable,
      contentType: info.mimeType,
      sha256: info.sha256,
    }),
    download.body.pipeTo(writable),
  ]);
  return { size: info.size, contentType: info.mimeType, sha256: info.sha256 ?? null };
}

async function graphError(response: Response): Promise<{ code: number | null; subcode: number | null }> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; error_subcode?: unknown } };
    return {
      code: typeof body.error?.code === "number" ? body.error.code : null,
      subcode: typeof body.error?.error_subcode === "number" ? body.error.error_subcode : null,
    };
  } catch {
    return { code: null, subcode: null };
  }
}

/** R2 refuses a write whose bytes do not match the SHA-256 it was given. */
export function isChecksumMismatch(error: unknown): boolean {
  return error instanceof Error && /checksum/i.test(error.message);
}

function parseMediaInfo(value: unknown): MetaMediaInfo {
  const body = (value ?? {}) as Record<string, unknown>;
  const size = Number(body.file_size);
  if (typeof body.url !== "string" || !body.url.startsWith("https://")) {
    throw new Error("media lookup returned no download URL");
  }
  if (typeof body.mime_type !== "string" || body.mime_type === "") {
    throw new Error("media lookup returned no mime type");
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("media lookup returned no file size");
  return {
    url: body.url,
    mimeType: body.mime_type,
    sha256: hexDigest(body.sha256),
    size,
  };
}

/** Meta's `sha256` is documented without an encoding, so both forms are read: base64 of the
 * 32-byte digest (44 characters) and hex (64). R2 takes lowercase hex. Anything else gives no
 * digest, and the file is then checked by its size alone. */
function hexDigest(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return [...atob(value)].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }
  return undefined;
}
