import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import type { SecretClaimRequest } from "@eccos/gateway-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { GatewayRPC } from "../../src/rpc";
import { createSecretClaim, SECRET_CLAIM_TTL_MS } from "../../src/secret-claims";
import { bootstrapAccount } from "./helpers";

const cp = <T>(fn: (instance: EccosControlPlane) => T | Promise<T>) => runInDurableObject(getControlPlaneStub(env), fn);
const gw = <T>(wabaId: string, fn: (instance: EccosGateway) => T | Promise<T>) =>
  runInDurableObject(getGatewayStubForWaba(env, wabaId), fn);
const rpc = () => new GatewayRPC(createExecutionContext(), env);
const creator = { userId: "user_a", clientId: "https://agent.example/c.json" };
const subscriber = { kind: "subscriber_secret", wabaId: "WABA_A" } as const;

async function ws(organizationId: string, wabaId?: string) {
  const { accountId } = await rpc().ensureOrganizationAccount(organizationId, `WS ${organizationId}`);
  if (wabaId) await bootstrapAccount(accountId, wabaId, [{ phoneNumberId: `PN_${wabaId}` }]);
  return accountId;
}

async function issue(accountId: string, request: SecretClaimRequest) {
  const issued = await rpc().createSecretClaim(accountId, request, creator);
  if (issued === "too_many_pending") throw new Error("too many pending claims");
  return issued;
}

const tag = (result: unknown) => (result === null ? "null" : typeof result === "string" ? result : "redeemed");
const secretOf = (result: unknown) => (result && typeof result === "object" ? (result as { secret: string }).secret : null);
const inForce = (wabaId: string) => gw(wabaId, (instance) => instance.getConfigValue("SUBSCRIBER_SECRET"));

/** Every row of every table the gateway owns, in the control plane and, when named, one WABA's object. */
async function dumpAll(wabaId?: string) {
  const dump = (sql: SqlStorage) => {
    const tables = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name as string)
      .filter((name) => !name.startsWith("_") && !name.startsWith("sqlite"));
    return JSON.stringify(Object.fromEntries(tables.map((table) => [table, sql.exec(`SELECT * FROM "${table}"`).toArray()])));
  };
  const control = await cp((instance) => dump(instance.sql));
  const gateway = wabaId ? await gw(wabaId, (instance) => dump((instance as unknown as { sql: SqlStorage }).sql)) : "";
  return control + gateway;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await reset();
});

describe("secret claim attacks", () => {
  it("mints exactly one key for 50 parallel redemptions", async () => {
    const a = await ws("org_a");
    const claim = await issue(a, { kind: "api_key", label: "L" });

    const tags = (await Promise.all(Array.from({ length: 50 }, () => rpc().redeemSecretClaim(claim.token)))).map(tag);

    expect(tags.filter((t) => t === "redeemed")).toHaveLength(1);
    expect(tags.filter((t) => t === "gone")).toHaveLength(49);
    expect(await rpc().listApiKeys(a)).toHaveLength(1);
  });

  it("generates exactly one subscriber secret for 50 parallel redemptions, the one in force", async () => {
    const a = await ws("org_a", "WABA_A");
    await gw("WABA_A", (instance) => instance.setSubscriberConfig({ url: "https://hook.example/x", secret: "old-secret" }));
    const claim = await issue(a, subscriber);

    const results = await Promise.all(Array.from({ length: 50 }, () => rpc().redeemSecretClaim(claim.token)));
    const won = results.filter((result) => tag(result) === "redeemed");

    expect(won).toHaveLength(1);
    expect(results.filter((result) => result === "gone")).toHaveLength(49);
    expect(secretOf(won[0])).toBe(await inForce("WABA_A"));
    expect(await gw("WABA_A", (instance) => instance.getConfigValue("SUBSCRIBER_WEBHOOK_URL"))).toBe(
      "https://hook.example/x",
    );
  });

  it("never mints after expiry when redemptions straddle it", async () => {
    const a = await ws("org_a");
    for (let n = 0; n < 20; n++) {
      const claim = await cp((instance) =>
        createSecretClaim(
          instance.sql,
          a,
          { kind: "api_key", label: null, wabaId: null, creatorUserId: "u", clientId: "c", secretRevision: null },
          Date.now() - SECRET_CLAIM_TTL_MS + 3,
        ),
      );
      if (claim === "too_many_pending") throw new Error("too many pending claims");
      const results = await Promise.all(
        Array.from({ length: 10 }, async (_, k) => {
          await new Promise((resolve) => setTimeout(resolve, k));
          return rpc().redeemSecretClaim(claim.token);
        }),
      );
      expect(results.filter((result) => tag(result) === "redeemed").length).toBeLessThanOrEqual(1);
      expect(results.every((result) => ["redeemed", "gone"].includes(tag(result)))).toBe(true);
    }
    const stored = await cp((instance) => instance.sql.exec("SELECT redeemed_at, expires_at FROM secret_claims").toArray());
    for (const row of stored) {
      if (row.redeemed_at !== null) expect(Number(row.redeemed_at)).toBeLessThan(Number(row.expires_at));
    }
  });

  it("stores no token or minted secret anywhere, before redemption or after expiry", async () => {
    const a = await ws("org_a", "WABA_A");
    vi.useFakeTimers({ toFake: ["Date"] });
    const key = await issue(a, { kind: "api_key", label: "L" });
    const sub = await issue(a, subscriber);
    const secrets = [key.token.split(".")[1] as string, sub.token.split(".")[1] as string];
    const before = await dumpAll("WABA_A");

    vi.setSystemTime(Date.now() + SECRET_CLAIM_TTL_MS + 1);
    const after = [
      await rpc().redeemSecretClaim(key.token),
      await rpc().redeemSecretClaim(sub.token),
      await rpc().resolveSecretClaim(key.token),
    ];
    const dumped = await dumpAll("WABA_A");

    expect(before).toContain(key.claimId);
    for (const secret of secrets) {
      expect(before).not.toContain(secret);
      expect(dumped).not.toContain(secret);
    }
    expect(after.map(tag)).toEqual(["gone", "gone", "null"]);
    expect(await rpc().listApiKeys(a)).toHaveLength(0);
    expect(await inForce("WABA_A")).toBeNull();
    expect(await rpc().listSecretClaims(a)).toEqual([]);
  });

  it("refuses wrong, truncated, extended and swapped tokens, and a replay", async () => {
    const a = await ws("org_a");
    const b = await ws("org_b");
    const claim = await issue(a, { kind: "api_key" });
    const other = await issue(b, { kind: "api_key" });
    const [selector, secret] = claim.token.split(".") as [string, string];
    const otherSecret = other.token.split(".")[1] as string;
    const probes = [
      `${selector}.${"A".repeat(43)}`,
      claim.token.slice(0, -1),
      `${claim.token}A`,
      `${claim.token}\n`,
      selector,
      `${selector}.${otherSecret}`,
      "",
      `AAAAAAAAAAA.${secret}`,
    ];

    for (const probe of probes) {
      expect(await rpc().redeemSecretClaim(probe)).toBeNull();
      expect(await rpc().resolveSecretClaim(probe)).toBeNull();
    }
    expect(await rpc().redeemSecretClaim(42 as unknown as string)).toBeNull();
    expect(tag(await rpc().redeemSecretClaim(claim.token))).toBe("redeemed");
    expect(await rpc().redeemSecretClaim(claim.token)).toBe("gone");
    expect(await rpc().resolveSecretClaim(claim.token)).toBeNull();
  });

  it("keeps claims inside their account", async () => {
    const a = await ws("org_a", "WABA_A");
    const b = await ws("org_b", "WABA_B");
    const bare = (await cp((instance) => instance.createAccount({ accountId: "acc_bare" }))).account.accountId;

    await expect(rpc().createSecretClaim(a, { kind: "subscriber_secret", wabaId: "WABA_B" }, creator)).rejects.toThrow();
    await expect(rpc().createSecretClaim("acc_nope", { kind: "api_key" }, creator)).rejects.toThrow();
    await expect(rpc().createSecretClaim(bare, { kind: "api_key" }, creator)).rejects.toThrow(/organization/);
    await expect(
      rpc().createSecretClaim(a, { kind: "admin" } as unknown as SecretClaimRequest, creator),
    ).rejects.toThrow(/kind/);
    await expect(
      rpc().createSecretClaim(a, { kind: "api_key" }, undefined as unknown as typeof creator),
    ).rejects.toThrow(/creatorUserId/);

    const claim = await issue(a, { kind: "api_key", label: "A" });
    const secret = claim.token.split(".")[1] as string;
    expect(await rpc().listSecretClaims(b)).toEqual([]);
    expect(JSON.stringify(await rpc().listSecretClaims(a))).not.toContain(secret);
    expect(JSON.stringify(await rpc().resolveSecretClaim(claim.token))).not.toContain(secret);

    const redeemed = await rpc().redeemSecretClaim(claim.token);
    if (!redeemed || typeof redeemed === "string" || !("keyId" in redeemed)) throw new Error("not redeemed");
    expect((await cp((instance) => instance.authenticateApiKey(redeemed.secret)))?.accountId).toBe(a);
    expect(await rpc().revokeApiKey(b, redeemed.keyId)).toBe(false);
  });

  it("keeps an operator secret set after a claim was made, and cancels the claim", async () => {
    const a = await ws("org_a", "WABA_A");
    const claim = await issue(a, subscriber);
    await rpc().setSubscriberConfig({ url: "https://hook.example/x", secret: "operator-chosen-secret" }, "WABA_A", a);

    expect(await rpc().redeemSecretClaim(claim.token)).toBe("cancelled");
    expect(await inForce("WABA_A")).toBe("operator-chosen-secret");
  });

  it("cancels a claim whose secret revision went stale behind the control plane's back", async () => {
    const a = await ws("org_a", "WABA_A");
    const claim = await issue(a, subscriber);
    await gw("WABA_A", (instance) =>
      instance.setSubscriberConfig({ url: "https://hook.example/x", secret: "operator-chosen-secret" }),
    );

    expect(await rpc().resolveSecretClaim(claim.token)).toMatchObject({ claimId: claim.claimId });
    expect(await rpc().redeemSecretClaim(claim.token)).toBe("cancelled");
    expect(await inForce("WABA_A")).toBe("operator-chosen-secret");
    expect(await rpc().redeemSecretClaim(claim.token)).toBe("cancelled");
    expect(await rpc().resolveSecretClaim(claim.token)).toBeNull();
  });

  it("leaves no secret when it was cleared after the claim was made", async () => {
    const a = await ws("org_a", "WABA_A");
    await gw("WABA_A", (instance) => instance.setSubscriberConfig({ url: "https://hook.example/x", secret: "old-secret" }));
    const claim = await issue(a, subscriber);
    await gw("WABA_A", (instance) => instance.setSubscriberConfig({ url: "https://hook.example/x", secret: null }));

    expect(await rpc().redeemSecretClaim(claim.token)).toBe("cancelled");
    expect(await inForce("WABA_A")).toBeNull();
  });

  it("lets only the newest of three claims for one WABA be redeemed", async () => {
    const a = await ws("org_a", "WABA_A");
    const claims = [await issue(a, subscriber), await issue(a, subscriber), await issue(a, subscriber)];

    const results = await Promise.all(claims.map((claim) => rpc().redeemSecretClaim(claim.token)));

    expect(results.map(tag)).toEqual(["cancelled", "cancelled", "redeemed"]);
    expect(secretOf(results[2])).toBe(await inForce("WABA_A"));
  });

  it("gives the secret in force to exactly one redeemer when claims are made and redeemed in parallel", async () => {
    const a = await ws("org_a", "WABA_A");
    for (let n = 0; n < 5; n++) {
      const claims = await Promise.all([1, 2, 3].map(() => issue(a, subscriber)));
      const results = await Promise.all(claims.map((claim) => rpc().redeemSecretClaim(claim.token)));
      const won = results.filter((result) => tag(result) === "redeemed");

      expect(won).toHaveLength(1);
      expect(results.filter((result) => result === "cancelled")).toHaveLength(2);
      expect(secretOf(won[0])).toBe(await inForce("WABA_A"));
    }
  });
});

describe("failed secret write", () => {
  it("answers write_failed and leaves the old secret and URL in force", async () => {
    const a = await ws("org_a", "WABA_A");
    await gw("WABA_A", (instance) => instance.setSubscriberConfig({ url: "https://hook.example/x", secret: "old-secret" }));
    const claim = await issue(a, subscriber);
    const spy = vi.spyOn(EccosGateway.prototype, "setSubscriberSecret").mockImplementation(() => {
      throw new Error("storage down");
    });

    expect(await rpc().redeemSecretClaim(claim.token)).toBe("write_failed");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await rpc().redeemSecretClaim(claim.token)).toBe("write_failed");
    expect(await inForce("WABA_A")).toBe("old-secret");
    expect(await gw("WABA_A", (instance) => instance.getConfigValue("SUBSCRIBER_WEBHOOK_URL"))).toBe(
      "https://hook.example/x",
    );
    expect(await rpc().listSecretClaims(a)).toEqual([]);
  });
});
