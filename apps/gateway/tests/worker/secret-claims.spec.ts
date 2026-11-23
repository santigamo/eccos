import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import type { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { GatewayRPC } from "../../src/rpc";
import { SECRET_CLAIM_TTL_MS } from "../../src/secret-claims";
import { bootstrapAccount } from "./helpers";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function rpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

const creator = { userId: "user_ruben", clientId: "https://agent.example/client.json" };

/** An organization-linked workspace, with a WABA when one is named. */
async function workspace(organizationId = "org_agency", wabaId?: string) {
  const { accountId } = await rpc().ensureOrganizationAccount(organizationId, "Agency");
  if (wabaId) await bootstrapAccount(accountId, wabaId, [{ phoneNumberId: `PN_${wabaId}` }]);
  return accountId;
}

async function keyClaim(accountId: string, label = "Production") {
  return rpc().createSecretClaim(accountId, { kind: "api_key", label }, creator);
}

function storedSecret(wabaId: string) {
  return runInDurableObject(getGatewayStubForWaba(env, wabaId), (instance: EccosGateway) =>
    instance.getConfigValue("SUBSCRIBER_SECRET"),
  );
}

afterEach(async () => {
  vi.useRealTimers();
  await reset();
});

describe("secret claims", () => {
  it("mints nothing and stores no secret when a claim is created", async () => {
    const accountId = await workspace();
    const before = await rpc().listApiKeys(accountId);
    const issued = await keyClaim(accountId);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{43}$/);
    expect(issued.claimId).toBe(issued.token.split(".")[0]);
    expect(issued.expiresAt - Date.now()).toBeGreaterThan(SECRET_CLAIM_TTL_MS - 5_000);
    expect(await rpc().listApiKeys(accountId)).toEqual(before);
    expect(await rpc().listSecretClaims(accountId)).toEqual([
      {
        claimId: issued.claimId,
        accountId,
        organizationId: "org_agency",
        creatorUserId: creator.userId,
        clientId: creator.clientId,
        createdAt: expect.any(Number),
        expiresAt: issued.expiresAt,
        kind: "api_key",
        label: "Production",
      },
    ]);
    const stored = JSON.stringify(await cp((instance) => instance.sql.exec("SELECT * FROM secret_claims").toArray()));
    expect(stored).not.toContain(issued.token.split(".")[1]);
  });

  it("issues the key only when the claim is redeemed", async () => {
    const accountId = await workspace();
    const issued = await keyClaim(accountId);

    const redeemed = await rpc().redeemSecretClaim(issued.token);
    if (!redeemed || redeemed === "gone" || !("keyId" in redeemed)) {
      throw new Error(`not redeemed: ${JSON.stringify(redeemed)}`);
    }
    expect(redeemed.secret).toMatch(/^ek_/);
    expect(redeemed.claim).toMatchObject({ claimId: issued.claimId, accountId, kind: "api_key", label: "Production" });
    expect(await cp((instance) => instance.authenticateApiKey(redeemed.secret))).toEqual({
      accountId,
      keyId: redeemed.keyId,
    });
    expect((await rpc().listApiKeys(accountId)).find((key) => key.keyId === redeemed.keyId)).toEqual({
      keyId: redeemed.keyId,
      label: "Production",
      createdAt: expect.any(Number),
      revokedAt: null,
    });
    expect(await rpc().listSecretClaims(accountId)).toEqual([]);
    expect(await rpc().resolveSecretClaim(issued.token)).toBeNull();
  });

  it("is single use", async () => {
    const accountId = await workspace();
    const before = (await rpc().listApiKeys(accountId)).length;
    const issued = await keyClaim(accountId);

    expect(await rpc().redeemSecretClaim(issued.token)).toMatchObject({ secret: expect.stringMatching(/^ek_/) });
    expect(await rpc().redeemSecretClaim(issued.token)).toBe("gone");
    expect(await rpc().listApiKeys(accountId)).toHaveLength(before + 1);
  });

  it("leaves nothing behind when it expires unclaimed", async () => {
    const accountId = await workspace();
    const before = await rpc().listApiKeys(accountId);
    const issued = await keyClaim(accountId);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + SECRET_CLAIM_TTL_MS + 1_000);

    expect(await rpc().resolveSecretClaim(issued.token)).toBeNull();
    expect(await rpc().redeemSecretClaim(issued.token)).toBe("gone");
    expect(await rpc().listApiKeys(accountId)).toEqual(before);
    expect(await rpc().listSecretClaims(accountId)).toEqual([]);
  });

  it.each([2, 5])("mints exactly one key when %i redemptions race", async (racers) => {
    const accountId = await workspace();
    const before = (await rpc().listApiKeys(accountId)).length;
    const issued = await keyClaim(accountId);

    const results = await Promise.all(Array.from({ length: racers }, () => rpc().redeemSecretClaim(issued.token)));

    expect(results.filter((result) => result !== null && result !== "gone")).toHaveLength(1);
    expect(results.filter((result) => result === "gone")).toHaveLength(racers - 1);
    expect(await rpc().listApiKeys(accountId)).toHaveLength(before + 1);
  });

  it("answers null for a wrong token and leaves the claim redeemable", async () => {
    const accountId = await workspace();
    const issued = await keyClaim(accountId);
    const [selector, secret] = issued.token.split(".") as [string, string];
    const otherSecret = `${secret[0] === "A" ? "B" : "A"}${secret.slice(1)}`;

    for (const token of ["not-a-token", `AAAAAAAAAAA.${secret}`, `${selector}.${otherSecret}`]) {
      expect(await rpc().resolveSecretClaim(token)).toBeNull();
      expect(await rpc().redeemSecretClaim(token)).toBeNull();
    }
    expect(await rpc().resolveSecretClaim(issued.token)).toMatchObject({ claimId: issued.claimId });
    expect(await rpc().redeemSecretClaim(issued.token)).toMatchObject({ claim: { claimId: issued.claimId } });
  });

  it("keeps each account's claims to itself", async () => {
    const accountA = await workspace("org_a", "WABA_A");
    const accountB = await workspace("org_b", "WABA_B");

    await expect(
      rpc().createSecretClaim(accountB, { kind: "subscriber_secret", wabaId: "WABA_A" }, creator),
    ).rejects.toThrow();
    const issued = await keyClaim(accountA);
    await rpc().createSecretClaim(accountA, { kind: "subscriber_secret", wabaId: "WABA_A" }, creator);
    expect(await rpc().listSecretClaims(accountB)).toEqual([]);
    expect((await rpc().listSecretClaims(accountA)).map((claim) => claim.kind).sort()).toEqual([
      "api_key",
      "subscriber_secret",
    ]);

    const keysA = (await rpc().listApiKeys(accountA)).length;
    const keysB = await rpc().listApiKeys(accountB);
    await rpc().redeemSecretClaim(issued.token);
    expect(await rpc().listApiKeys(accountA)).toHaveLength(keysA + 1);
    expect(await rpc().listApiKeys(accountB)).toEqual(keysB);
  });

  it("validates what a claim is created for", async () => {
    const accountId = await workspace("org_agency", "WABA_A");
    await expect(rpc().createSecretClaim("acc_missing", { kind: "api_key" }, creator)).rejects.toThrow();
    await expect(keyClaim(accountId, "x".repeat(500))).rejects.toThrow(/label/);
    await expect(
      rpc().createSecretClaim(accountId, { kind: "api_key" }, { userId: "user ruben", clientId: "c" }),
    ).rejects.toThrow(/creatorUserId/);
    await expect(
      rpc().createSecretClaim(accountId, { kind: "api_key" }, { userId: "user_ruben", clientId: "has space" }),
    ).rejects.toThrow(/clientId/);
    await expect(
      rpc().createSecretClaim(accountId, { kind: "subscriber_secret", wabaId: "WABA_NOT_HERE" }, creator),
    ).rejects.toThrow();
    const claim = await rpc().createSecretClaim(accountId, { kind: "api_key" }, creator);
    expect(await rpc().resolveSecretClaim(claim.token)).toMatchObject({ kind: "api_key", label: null });
  });

  it("generates and stores the subscriber secret on redemption, keeping the URL", async () => {
    const accountId = await workspace("org_agency", "WABA_A");
    const url = "https://subscriber.example/hook";
    await rpc().setSubscriberConfig({ url, secret: "previous-secret" }, "WABA_A", accountId);

    const issued = await rpc().createSecretClaim(accountId, { kind: "subscriber_secret", wabaId: "WABA_A" }, creator);
    expect(await storedSecret("WABA_A")).toBe("previous-secret");
    expect(await rpc().resolveSecretClaim(issued.token)).toMatchObject({ kind: "subscriber_secret", wabaId: "WABA_A" });

    const redeemed = await rpc().redeemSecretClaim(issued.token);
    if (!redeemed || redeemed === "gone") throw new Error("not redeemed");
    expect(redeemed.claim).toMatchObject({ kind: "subscriber_secret", wabaId: "WABA_A" });
    expect(redeemed.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await storedSecret("WABA_A")).toBe(redeemed.secret);
    expect(await rpc().getSubscriberConfig("WABA_A", accountId)).toMatchObject({ url, hasSecret: true });
    expect(await rpc().redeemSecretClaim(issued.token)).toBe("gone");
    expect(await storedSecret("WABA_A")).toBe(redeemed.secret);
  });

  it("stores a subscriber secret without inventing a URL", async () => {
    const accountId = await workspace("org_agency", "WABA_A");
    const issued = await rpc().createSecretClaim(accountId, { kind: "subscriber_secret", wabaId: "WABA_A" }, creator);

    expect(await rpc().redeemSecretClaim(issued.token)).toMatchObject({
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await rpc().getSubscriberConfig("WABA_A", accountId)).toMatchObject({ url: null, hasSecret: true });
  });

  it("fails closed when the workspace's organization link is not active", async () => {
    const accountId = await workspace("org_agency", "WABA_A");
    const before = await rpc().listApiKeys(accountId);
    const keyToken = (await keyClaim(accountId)).token;
    const secretToken = (
      await rpc().createSecretClaim(accountId, { kind: "subscriber_secret", wabaId: "WABA_A" }, creator)
    ).token;
    await cp((instance) => instance.sql.exec("UPDATE organization_accounts SET status = 'disabled'"));

    for (const token of [keyToken, secretToken]) {
      expect(await rpc().resolveSecretClaim(token)).toBeNull();
      expect(await rpc().redeemSecretClaim(token)).toBe("gone");
    }
    expect(await rpc().listSecretClaims(accountId)).toEqual([]);
    await expect(keyClaim(accountId)).rejects.toThrow(/organization/);
    expect(await rpc().listApiKeys(accountId)).toEqual(before);
    expect(await storedSecret("WABA_A")).toBeNull();
  });

  it("fails closed when the account no longer owns the WABA", async () => {
    const accountId = await workspace("org_agency", "WABA_A");
    const issued = await rpc().createSecretClaim(accountId, { kind: "subscriber_secret", wabaId: "WABA_A" }, creator);
    await cp((instance) => instance.sql.exec("DELETE FROM wabas WHERE waba_id = 'WABA_A'"));

    expect(await rpc().resolveSecretClaim(issued.token)).toBeNull();
    expect(await rpc().redeemSecretClaim(issued.token)).toBe("gone");
    expect(await rpc().listSecretClaims(accountId)).toEqual([]);
    expect(await storedSecret("WABA_A")).toBeNull();
  });
});
