const WABA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MEDIA_ID = /^\d{1,32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const LIST_PAGE_SIZE = 1000;

export interface MediaInput {
  wabaId: string;
  mediaId: string;
  body: ReadableStream | ArrayBuffer | ArrayBufferView | Blob | string;
  contentType: string;
  /** Hex SHA-256 of `body`. R2 rejects the write when the bytes do not match. */
  sha256?: string;
}

export interface StoredMedia {
  body: ReadableStream;
  contentType: string | undefined;
  sha256: string | undefined;
  size: number;
}

function wabaPrefix(wabaId: string): string {
  if (!WABA_ID.test(wabaId)) throw new Error("Invalid WABA ID for media storage");
  return `waba/${wabaId}/media/`;
}

function mediaKey(wabaId: string, mediaId: string): string {
  if (!MEDIA_ID.test(mediaId)) throw new Error("Invalid media ID");
  return `${wabaPrefix(wabaId)}${mediaId}`;
}

export async function putMedia(bucket: R2Bucket, input: MediaInput): Promise<void> {
  const { wabaId, mediaId, body, contentType, sha256 } = input;
  if (sha256 !== undefined && !SHA256_HEX.test(sha256)) throw new Error("Invalid SHA-256 digest");
  await bucket.put(mediaKey(wabaId, mediaId), body, {
    httpMetadata: { contentType },
    customMetadata: sha256 ? { sha256 } : undefined,
    sha256,
  });
}

export async function getMedia(
  bucket: R2Bucket,
  wabaId: string,
  mediaId: string,
): Promise<StoredMedia | null> {
  const object = await bucket.get(mediaKey(wabaId, mediaId));
  if (!object) return null;
  return {
    body: object.body,
    contentType: object.httpMetadata?.contentType,
    sha256: object.customMetadata?.sha256,
    size: object.size,
  };
}

/** Deletes every object under the WABA's prefix, page by page. Returns the count removed. */
export async function deleteMediaForWaba(bucket: R2Bucket, wabaId: string): Promise<number> {
  const prefix = wabaPrefix(wabaId);
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: LIST_PAGE_SIZE });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
