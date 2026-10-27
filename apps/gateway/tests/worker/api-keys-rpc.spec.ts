import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount } from "./helpers";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function rpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

afterEach(async () => {
  await reset();
});

describe("GatewayRPC account keys", () => {
  it("issues a working ek_ key once and lists only its metadata", async () => {
    await bootstrapAccount("acct-a", "WABA_A");
    const issued = await rpc().issueApiKey("acct-a", "Production");
    expect(issued.apiKey).toMatch(/^ek_/);

    const owner = await cp((instance) => instance.authenticateApiKey(issued.apiKey));
    expect(owner).toEqual({ accountId: "acct-a", keyId: issued.keyId });

    const keys = await rpc().listApiKeys("acct-a");
    const listed = keys.find((key) => key.keyId === issued.keyId);
    expect(listed).toEqual({
      keyId: issued.keyId,
      label: "Production",
      createdAt: expect.any(Number),
      revokedAt: null,
    });
    const hash = await cp(
      (instance) =>
        instance.sql.exec("SELECT hash FROM api_keys WHERE key_id = ?", issued.keyId).toArray()[0]?.hash as string,
    );
    const serialized = JSON.stringify(keys);
    expect(serialized).not.toContain(issued.apiKey);
    expect(serialized).not.toContain(hash);
  });

  it("revokes once, and a revoked key no longer authenticates", async () => {
    await bootstrapAccount("acct-a", "WABA_A");
    const issued = await rpc().issueApiKey("acct-a");

    expect(await rpc().revokeApiKey("acct-a", issued.keyId)).toBe(true);
    expect(await rpc().revokeApiKey("acct-a", issued.keyId)).toBe(false);

    const listed = (await rpc().listApiKeys("acct-a")).find((key) => key.keyId === issued.keyId);
    expect(listed?.revokedAt).toEqual(expect.any(Number));
    expect(await cp((instance) => instance.authenticateApiKey(issued.apiKey))).toBeNull();
  });

  it("keeps each account's keys out of every other account's reach", async () => {
    await bootstrapAccount("acct-a", "WABA_A");
    await bootstrapAccount("acct-b", "WABA_B", [{ phoneNumberId: "PNID_B" }]);
    const keyA = await rpc().issueApiKey("acct-a", "A");
    const keyB = await rpc().issueApiKey("acct-b", "B");

    const listedByA = (await rpc().listApiKeys("acct-a")).map((key) => key.keyId);
    expect(listedByA).toContain(keyA.keyId);
    expect(listedByA).not.toContain(keyB.keyId);

    // A cannot revoke B's key, and B's key keeps working.
    expect(await rpc().revokeApiKey("acct-a", keyB.keyId)).toBe(false);
    expect(await cp((instance) => instance.authenticateApiKey(keyB.apiKey))).toEqual({
      accountId: "acct-b",
      keyId: keyB.keyId,
    });
    const listedByB = (await rpc().listApiKeys("acct-b")).find((key) => key.keyId === keyB.keyId);
    expect(listedByB?.revokedAt).toBeNull();
  });

  it("fails closed without an account, or for one that does not exist", async () => {
    await expect(rpc().listApiKeys("")).rejects.toThrow(/accountId is required/);
    await expect(rpc().issueApiKey("")).rejects.toThrow(/accountId is required/);
    await expect(rpc().revokeApiKey("", "key_x")).rejects.toThrow(/accountId is required/);
    await expect(rpc().listApiKeys("acct-missing")).rejects.toThrow(/does not exist/);
    await expect(rpc().issueApiKey("acct-missing")).rejects.toThrow(/does not exist/);
  });
});
