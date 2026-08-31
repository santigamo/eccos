import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { reset, runInDurableObject } from "cloudflare:test";
import {
  UNSEALED_TOKEN_ERROR,
  quarantineUnsealedWabas,
  type EccosControlPlane,
} from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { SEALED_TOKEN_PREFIX, sealToken, wabaTokenAad } from "../../src/token-crypto";

const CALLBACK_URL = "https://gateway.example/webhooks/meta";

afterEach(async () => {
  await reset();
});

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function storedToken(instance: EccosControlPlane, wabaId: string): string | null {
  const row = instance.sql
    .exec("SELECT meta_access_token FROM wabas WHERE waba_id = ?", wabaId)
    .toArray()[0];
  return (row?.meta_access_token as string | undefined) ?? null;
}

async function register(
  accountId: string,
  wabaId: string,
  token: string,
  phoneNumberId: string,
): Promise<void> {
  await cp(async (instance) => {
    await instance.createAccount({ accountId });
    await instance.registerWaba({
      accountId,
      wabaId,
      metaAccessToken: token,
      callbackUrl: CALLBACK_URL,
      provisioningStatus: "active",
      phones: [{ phoneNumberId }],
    });
  });
}

describe("meta access token encryption at rest", () => {
  it("stores an ecs1 envelope, never the plaintext token", async () => {
    const token = "EAAG_dogfood_business_token";
    await register("acc-crypto", "WABA_CRYPTO", token, "PN_CRYPTO");

    await cp(async (instance) => {
      const stored = storedToken(instance, "WABA_CRYPTO");
      expect(stored).not.toBeNull();
      expect(stored).toContain(SEALED_TOKEN_PREFIX);
      expect(stored).not.toContain(token);
      // The whole registry row must be free of the plaintext, not just the column.
      const dump = JSON.stringify(
        instance.sql.exec("SELECT * FROM wabas WHERE waba_id = ?", "WABA_CRYPTO").toArray(),
      );
      expect(dump).not.toContain(token);
    });

    // ...and the owning account still reads the plaintext back.
    await cp(async (instance) =>
      expect((await instance.getWaba("acc-crypto", "WABA_CRYPTO"))?.metaAccessToken).toBe(token),
    );
  });

  it("re-seals on every write, so the stored envelope is never a stable ciphertext", async () => {
    const token = "EAAG_repeat_business_token";
    await register("acc-repeat", "WABA_REPEAT", token, "PN_REPEAT");
    const first = await cp((instance) => storedToken(instance, "WABA_REPEAT"));
    await cp(async (instance) => {
      await instance.registerWaba({
        accountId: "acc-repeat",
        wabaId: "WABA_REPEAT",
        metaAccessToken: token,
        provisioningStatus: "active",
        phones: [{ phoneNumberId: "PN_REPEAT" }],
      });
    });
    const second = await cp((instance) => storedToken(instance, "WABA_REPEAT"));
    expect(first).not.toBe(second);
    await cp(async (instance) =>
      expect((await instance.getWaba("acc-repeat", "WABA_REPEAT"))?.metaAccessToken).toBe(token),
    );
  });

  it("fails closed on a record sealed with a different key", async () => {
    await register("acc-wrongkey", "WABA_WRONGKEY", "EAAG_ok", "PN_WRONGKEY");
    const foreign = await sealToken(
      "a-completely-different-key-not-the-deployment-one",
      wabaTokenAad("acc-wrongkey", "WABA_WRONGKEY"),
      "EAAG_sealed_elsewhere",
    );
    await cp((instance) => {
      instance.sql.exec(
        "UPDATE wabas SET meta_access_token = ? WHERE waba_id = ?",
        foreign,
        "WABA_WRONGKEY",
      );
    });
    await expect(
      cp((instance) => instance.getWaba("acc-wrongkey", "WABA_WRONGKEY")),
    ).rejects.toThrow(/could not be decrypted/);
  });

  it("fails closed when a sealed token is moved onto another account's WABA", async () => {
    await register("acc-aad-a", "WABA_AAD_A", "EAAG_account_a", "PN_AAD_A");
    await register("acc-aad-b", "WABA_AAD_B", "EAAG_account_b", "PN_AAD_B");
    // An attacker with storage write access copies A's sealed token onto B's row.
    await cp((instance) => {
      const stolen = storedToken(instance, "WABA_AAD_A");
      instance.sql.exec(
        "UPDATE wabas SET meta_access_token = ? WHERE waba_id = ?",
        stolen,
        "WABA_AAD_B",
      );
    });
    await expect(
      cp((instance) => instance.getWaba("acc-aad-b", "WABA_AAD_B")),
    ).rejects.toThrow(/could not be decrypted/);
    // A's own row still opens: the binding is what failed, not the key.
    await cp(async (instance) =>
      expect((await instance.getWaba("acc-aad-a", "WABA_AAD_A"))?.metaAccessToken).toBe(
        "EAAG_account_a",
      ),
    );
  });

  it("quarantines pre-encryption plaintext rows idempotently instead of migrating them", async () => {
    await register("acc-legacy", "WABA_LEGACY", "EAAG_current", "PN_LEGACY");
    // Simulate a row written before token encryption existed.
    await cp((instance) => {
      instance.sql.exec(
        "UPDATE wabas SET meta_access_token = ? WHERE waba_id = ?",
        "EAAG_legacy_plaintext_token",
        "WABA_LEGACY",
      );
    });

    const first = await cp((instance) => quarantineUnsealedWabas(instance.sql));
    expect(first).toBe(1);
    // Idempotent: the quarantine is re-run on every Durable Object init.
    const second = await cp((instance) => quarantineUnsealedWabas(instance.sql));
    const third = await cp((instance) => quarantineUnsealedWabas(instance.sql));
    expect(second).toBe(0);
    expect(third).toBe(0);

    await cp((instance) => {
      const row = instance.sql
        .exec("SELECT status, provisioning_error FROM wabas WHERE waba_id = ?", "WABA_LEGACY")
        .toArray()[0];
      expect(row?.status).toBe("failed");
      expect(row?.provisioning_error).toBe(UNSEALED_TOKEN_ERROR);
      // Never migrated in place: the plaintext is not silently re-encrypted.
      expect(storedToken(instance, "WABA_LEGACY")).toBe("EAAG_legacy_plaintext_token");
    });

    // Reads fail closed rather than handing out the plaintext.
    await expect(
      cp((instance) => instance.getWabaRecord("acc-legacy", "WABA_LEGACY")),
    ).rejects.toThrow(new RegExp(UNSEALED_TOKEN_ERROR));
    // `getWaba` resolves the (now failed) status before touching the token, so
    // the data plane sees "not configured" instead of an opaque crypto error.
    expect(await cp((instance) => instance.getWaba("acc-legacy", "WABA_LEGACY"))).toBeNull();
    // A quarantined WABA cannot be re-queued: retrying could never succeed.
    await expect(
      cp((instance) => instance.retryWabaProvisioning("acc-legacy", "WABA_LEGACY")),
    ).rejects.toThrow(new RegExp(UNSEALED_TOKEN_ERROR));
    expect(await cp((instance) => instance.claimPendingWabaProvisioning(10))).toEqual([]);

    // Reconnecting the number rewrites the row with a sealed envelope.
    await cp(async (instance) => {
      await instance.registerWaba({
        accountId: "acc-legacy",
        wabaId: "WABA_LEGACY",
        metaAccessToken: "EAAG_reconnected",
        provisioningStatus: "active",
        phones: [{ phoneNumberId: "PN_LEGACY" }],
      });
    });
    await cp(async (instance) => {
      expect(storedToken(instance, "WABA_LEGACY")).toContain(SEALED_TOKEN_PREFIX);
      expect((await instance.getWaba("acc-legacy", "WABA_LEGACY"))?.metaAccessToken).toBe(
        "EAAG_reconnected",
      );
      expect(quarantineUnsealedWabas(instance.sql)).toBe(0);
    });
  });

  it("hands the provisioning claim the decrypted token, from the sealed row", async () => {
    await cp(async (instance) => {
      await instance.createAccount({ accountId: "acc-claim" });
      await instance.beginWabaProvisioning({
        accountId: "acc-claim",
        wabaId: "WABA_CLAIM",
        metaAccessToken: "EAAG_claim_token",
        callbackUrl: CALLBACK_URL,
        phones: [{ phoneNumberId: "PN_CLAIM" }],
      });
    });
    await cp(async (instance) => {
      expect(storedToken(instance, "WABA_CLAIM")).toContain(SEALED_TOKEN_PREFIX);
      const claim = await instance.claimWabaProvisioning("acc-claim", "WABA_CLAIM");
      expect(claim?.metaAccessToken).toBe("EAAG_claim_token");
    });
  });

  it("keeps the provisioning fingerprint stable across identical registrations", async () => {
    const input = {
      accountId: "acc-fingerprint",
      wabaId: "WABA_FINGERPRINT",
      metaAccessToken: "EAAG_fingerprint_token",
      callbackUrl: CALLBACK_URL,
      phones: [{ phoneNumberId: "PN_FINGERPRINT" }],
    };
    await cp(async (instance) => {
      await instance.createAccount({ accountId: input.accountId });
      await instance.beginWabaProvisioning(input);
    });
    const before = await cp((instance) =>
      instance.sql
        .exec(
          "SELECT provisioning_fingerprint, provisioning_revision FROM wabas WHERE waba_id = ?",
          input.wabaId,
        )
        .toArray()[0],
    );
    await cp((instance) => instance.beginWabaProvisioning(input));
    const after = await cp((instance) =>
      instance.sql
        .exec(
          "SELECT provisioning_fingerprint, provisioning_revision FROM wabas WHERE waba_id = ?",
          input.wabaId,
        )
        .toArray()[0],
    );
    // The envelope changes on every seal; the fingerprint must not, or every
    // retry would re-subscribe the WABA with Meta.
    expect(after?.provisioning_fingerprint).toBe(before?.provisioning_fingerprint as string);
    expect(after?.provisioning_revision).toBe(before?.provisioning_revision as number);
  });

  it("refuses to write a token when the encryption key is missing", async () => {
    await cp(async (instance) => {
      await instance.createAccount({ accountId: "acc-nokey" });
      // The control plane reads its own `env`, so the binding is stripped on the
      // live instance for this check and restored right after.
      const original = instance.env.ECCOS_TOKEN_ENCRYPTION_KEY;
      Object.defineProperty(instance, "env", {
        value: { ...instance.env, ECCOS_TOKEN_ENCRYPTION_KEY: "" },
        configurable: true,
        writable: true,
      });
      try {
        await expect(
          instance.registerWaba({
            accountId: "acc-nokey",
            wabaId: "WABA_NOKEY",
            metaAccessToken: "EAAG_never_stored",
            provisioningStatus: "active",
            phones: [{ phoneNumberId: "PN_NOKEY" }],
          }),
        ).rejects.toThrow(/ECCOS_TOKEN_ENCRYPTION_KEY is required/);
      } finally {
        Object.defineProperty(instance, "env", {
          value: { ...instance.env, ECCOS_TOKEN_ENCRYPTION_KEY: original },
          configurable: true,
          writable: true,
        });
      }
      // Nothing was written: no half-registered row with a plaintext token.
      expect(storedToken(instance, "WABA_NOKEY")).toBeNull();
    });
  });
});
