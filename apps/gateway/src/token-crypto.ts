/**
 * Application-layer encryption for the Meta access tokens the control plane
 * stores in `wabas.meta_access_token`.
 *
 * Cloudflare already encrypts Durable Object storage at rest at the platform
 * level; this module adds the layer the platform cannot give us — a key that
 * lives in a Worker secret rather than in the storage system, so a leaked
 * database export (or a storage-level compromise) does not hand the attacker
 * live third-party business tokens.
 *
 * Scheme (envelope version `ecs1`):
 *
 *     ecs1.<base64url(iv)>.<base64url(ciphertext||tag)>
 *
 * - AES-256-GCM, fresh 96-bit random IV per record (never reused).
 * - Key derived with HKDF-SHA-256 from the `ECCOS_TOKEN_ENCRYPTION_KEY` Worker
 *   secret, so the secret may be any high-entropy string and the raw secret is
 *   never used directly as an AES key.
 * - The GCM additional data binds the envelope to `<accountId>:<wabaId>`: an
 *   attacker with write access to the storage cannot move account A's sealed
 *   token onto account B's WABA row — it simply fails to open. This reinforces
 *   the account-scoping invariant at the crypto layer.
 *
 * Fail closed: a missing/short key, a record that is not a valid envelope, a
 * wrong key, tampered bytes, or a mismatched account/WABA binding all throw.
 * There is no plaintext fallback and no "try plaintext" read path.
 *
 * SAFETY: nothing here logs. Errors never carry the key, the plaintext token,
 * or the envelope bytes — only the WABA/account identifiers the caller adds.
 */

/** Envelope version prefix. Bump (`ecs2.`) to rotate the scheme; the reader
 * dispatches on it, so old and new envelopes can never be confused. */
export const SEALED_TOKEN_PREFIX = "ecs1.";
/** Name of the Worker secret holding the key material. */
export const TOKEN_ENCRYPTION_KEY_VAR = "ECCOS_TOKEN_ENCRYPTION_KEY";
/** 32 random bytes, base64-encoded, is 44 characters; refuse anything that
 * cannot plausibly carry 256 bits of entropy. */
export const MIN_TOKEN_ENCRYPTION_KEY_LENGTH = 32;

const IV_BYTES = 12;
const HKDF_SALT = "eccos.control-plane.meta-access-token.salt.v1";
const HKDF_INFO = "eccos.control-plane.meta-access-token.aes-gcm-256.v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Single-entry derived-key cache: deriving on every read/write would be pure
 * overhead, and an unbounded cache keyed by secret material would not be. */
let derivedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Reads and validates the encryption key from the Worker env. Follows the
 * `getAppConfig` convention: a missing value is a configuration error, thrown
 * with the variable name and never with the value.
 */
export function requireTokenEncryptionKey(env: unknown): string {
  const values = (env ?? {}) as Record<string, unknown>;
  const raw = values[TOKEN_ENCRYPTION_KEY_VAR];
  const secret = typeof raw === "string" ? raw.trim() : "";
  if (secret.length < MIN_TOKEN_ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `Invalid Eccos configuration: ${TOKEN_ENCRYPTION_KEY_VAR} is required ` +
        `(at least ${MIN_TOKEN_ENCRYPTION_KEY_LENGTH} characters; generate with \`openssl rand -base64 32\`)`,
    );
  }
  return secret;
}

async function tokenKey(secret: string): Promise<CryptoKey> {
  const cached = derivedKey;
  if (cached && cached.secret === secret) return cached.key;
  const key = (async () => {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(HKDF_SALT),
        info: encoder.encode(HKDF_INFO),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  derivedKey = { secret, key };
  return key;
}

/** Additional authenticated data binding a sealed token to one account's WABA. */
export function wabaTokenAad(accountId: string, wabaId: string): string {
  return `eccos.waba.v1:${accountId}:${wabaId}`;
}

/** True when the stored value is an `ecs1` envelope (structure only — opening
 * it is what actually proves it). */
export function isSealedToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(SEALED_TOKEN_PREFIX) &&
    value.split(".").length === 3
  );
}

/** Encrypts a Meta access token for storage. */
export async function sealToken(
  secret: string,
  aad: string,
  plaintext: string,
): Promise<string> {
  if (!plaintext) throw new Error("cannot encrypt an empty meta access token");
  const key = await tokenKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  );
  return `${SEALED_TOKEN_PREFIX}${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

/**
 * Decrypts a stored envelope. Throws — never returns a fallback — when the
 * record is not an envelope, the key is wrong, the bytes were tampered with,
 * or the account/WABA binding does not match.
 */
export async function openToken(
  secret: string,
  aad: string,
  envelope: string,
): Promise<string> {
  if (!isSealedToken(envelope)) {
    throw new Error(
      "stored meta access token is not encrypted: reconnect the number (see docs/deployment.md)",
    );
  }
  const [, ivPart, sealedPart] = envelope.split(".");
  if (!ivPart || !sealedPart) {
    throw new Error("stored meta access token envelope is malformed");
  }
  const key = await tokenKey(secret);
  let plaintext: ArrayBuffer;
  try {
    const iv = fromBase64Url(ivPart);
    if (iv.length !== IV_BYTES) throw new Error("bad iv");
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      key,
      fromBase64Url(sealedPart),
    );
  } catch {
    // Deliberately opaque: the cause is either a wrong key, a tampered record,
    // or a record bound to a different account/WABA. Never echo any of the input.
    throw new Error(
      `meta access token could not be decrypted: wrong ${TOKEN_ENCRYPTION_KEY_VAR}, tampered record, or account/WABA mismatch`,
    );
  }
  const value = decoder.decode(plaintext);
  if (!value) throw new Error("meta access token could not be decrypted: empty plaintext");
  return value;
}

/** Test seam: drops the cached derived key. */
export function resetTokenKeyCache(): void {
  derivedKey = null;
}
