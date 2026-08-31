import { describe, it, expect } from "bun:test";
import {
  MIN_TOKEN_ENCRYPTION_KEY_LENGTH,
  SEALED_TOKEN_PREFIX,
  isSealedToken,
  openToken,
  requireTokenEncryptionKey,
  sealToken,
  wabaTokenAad,
} from "../src/token-crypto";

// Obviously fake key material — this repo is public/OSS and never carries a
// real secret. Any string of at least the minimum length is valid input.
const KEY = "unit-test-encryption-key-not-a-real-secret";
const OTHER_KEY = "another-unit-test-key-also-not-a-real-secret";
const TOKEN = "EAAG_fake_meta_business_token_value";
const AAD = wabaTokenAad("acc-1", "WABA_1");

describe("meta access token envelope", () => {
  it("round-trips a token through the ecs1 envelope", async () => {
    const sealed = await sealToken(KEY, AAD, TOKEN);
    expect(sealed.startsWith(SEALED_TOKEN_PREFIX)).toBe(true);
    expect(isSealedToken(sealed)).toBe(true);
    expect(await openToken(KEY, AAD, sealed)).toBe(TOKEN);
  });

  it("never leaks the plaintext into the envelope and never reuses an IV", async () => {
    const a = await sealToken(KEY, AAD, TOKEN);
    const b = await sealToken(KEY, AAD, TOKEN);
    expect(a).not.toContain(TOKEN);
    expect(b).not.toContain(TOKEN);
    // Random per-record IV: the same plaintext seals to a different envelope.
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
    expect(await openToken(KEY, AAD, b)).toBe(TOKEN);
  });

  it("fails closed on a wrong key", async () => {
    const sealed = await sealToken(KEY, AAD, TOKEN);
    await expect(openToken(OTHER_KEY, AAD, sealed)).rejects.toThrow(
      /could not be decrypted/,
    );
  });

  it("fails closed when the envelope is bound to another account or WABA", async () => {
    const sealed = await sealToken(KEY, AAD, TOKEN);
    await expect(
      openToken(KEY, wabaTokenAad("acc-2", "WABA_1"), sealed),
    ).rejects.toThrow(/could not be decrypted/);
    await expect(
      openToken(KEY, wabaTokenAad("acc-1", "WABA_2"), sealed),
    ).rejects.toThrow(/could not be decrypted/);
  });

  it("fails closed on tampered ciphertext", async () => {
    const sealed = await sealToken(KEY, AAD, TOKEN);
    const parts = sealed.split(".");
    const body = parts[2] ?? "";
    const flipped = `${body.slice(0, -1)}${body.at(-1) === "A" ? "B" : "A"}`;
    await expect(
      openToken(KEY, AAD, `${parts[0]}.${parts[1]}.${flipped}`),
    ).rejects.toThrow(/could not be decrypted/);
  });

  it("refuses to read a plaintext value: there is no legacy read path", async () => {
    expect(isSealedToken(TOKEN)).toBe(false);
    await expect(openToken(KEY, AAD, TOKEN)).rejects.toThrow(/is not encrypted/);
    await expect(openToken(KEY, AAD, "")).rejects.toThrow(/is not encrypted/);
    await expect(openToken(KEY, AAD, "ecs1.only-two-parts")).rejects.toThrow(
      /is not encrypted/,
    );
  });

  it("refuses to seal an empty token", async () => {
    await expect(sealToken(KEY, AAD, "")).rejects.toThrow(/empty meta access token/);
  });
});

describe("requireTokenEncryptionKey", () => {
  it("returns the configured key", () => {
    expect(requireTokenEncryptionKey({ ECCOS_TOKEN_ENCRYPTION_KEY: KEY })).toBe(KEY);
    expect(requireTokenEncryptionKey({ ECCOS_TOKEN_ENCRYPTION_KEY: ` ${KEY} ` })).toBe(KEY);
  });

  it("fails closed when the key is missing, blank, or too short", () => {
    for (const env of [
      {},
      { ECCOS_TOKEN_ENCRYPTION_KEY: "" },
      { ECCOS_TOKEN_ENCRYPTION_KEY: "   " },
      { ECCOS_TOKEN_ENCRYPTION_KEY: "x".repeat(MIN_TOKEN_ENCRYPTION_KEY_LENGTH - 1) },
      { ECCOS_TOKEN_ENCRYPTION_KEY: 42 as unknown as string },
    ]) {
      expect(() => requireTokenEncryptionKey(env)).toThrow(
        /ECCOS_TOKEN_ENCRYPTION_KEY is required/,
      );
    }
  });

  it("never echoes the key value in the configuration error", () => {
    const secret = "short-but-secret";
    try {
      requireTokenEncryptionKey({ ECCOS_TOKEN_ENCRYPTION_KEY: secret });
      throw new Error("expected a configuration error");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
