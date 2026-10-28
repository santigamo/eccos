import { putMedia } from "./media-store";

/** Meta's largest media is a document at 100 MB. A bigger file is refused before any byte is read. */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const GRAPH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Graph subcode for "object does not exist", which is what an expired media id returns. */
const GRAPH_SUBCODE_NONEXISTENT = 33;

/** Retrying cannot succeed: Meta no longer has the id, or the file is over the limit. */
export class MediaPermanentError extends Error {
  override name = "MediaPermanentError";
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
 * Throws {@link MediaPermanentError} when retrying cannot help; any other error
 * is transient and the caller retries with backoff.
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
    if (lookup.status === 404 || (await graphSubcode(lookup)) === GRAPH_SUBCODE_NONEXISTENT) {
      throw new MediaPermanentError(`Meta no longer has media ${mediaId}`);
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
  return { size: info.size, contentType: info.mimeType, sha256: info.sha256?.toLowerCase() ?? null };
}

async function graphSubcode(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as { error?: { error_subcode?: unknown } };
    const subcode = body.error?.error_subcode;
    return typeof subcode === "number" ? subcode : null;
  } catch {
    return null;
  }
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
    sha256: typeof body.sha256 === "string" && body.sha256 !== "" ? body.sha256 : undefined,
    size,
  };
}
