import type { AccountKeyResource, SecretClaim } from "@eccos/gateway-contract";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  METADATA_URL,
  accountResources,
  activeWaba,
  call,
  connect,
  consoleStub,
  errorOf,
  gatewayStub,
  grantToken,
  listedTools,
  makeActor,
  postMcp,
  resetStubs,
  toolsCall,
} from "./helpers";

let logLines: string[] = [];

beforeEach(async () => {
  await resetStubs();
  await seed("acct-a", [{ keyId: "key_a1", label: "console", createdAt: Date.UTC(2026, 10, 1), revokedAt: null }]);
  logLines = [];
  for (const level of ["info", "log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const elevated = (overrides = {}) => makeActor({ elevatedUntil: Date.now() + 3_600_000, ...overrides });

async function seed(accountId: string, keys: AccountKeyResource[], claims: SecretClaim[] = []) {
  await gatewayStub.seed(accountId, {
    resources: { ...accountResources(accountId, [activeWaba(accountId === "acct-a" ? "waba-1" : "waba-b", accountId, ["111"])]), keys },
    claims,
  });
}

const pendingClaims = (accountId: string, count: number): SecretClaim[] =>
  Array.from({ length: count }, (_, index) => ({
    claimId: `${accountId}-claim-${index}`,
    accountId,
    organizationId: "org",
    creatorUserId: "someone",
    clientId: "client-1",
    createdAt: Date.UTC(2026, 10, 23, 12),
    expiresAt: Date.now() + 600_000,
    kind: "api_key",
    label: `label-${index}`,
  }));

const methods = async () => (await gatewayStub.calls()).map((entry) => entry.method);
const audits = () =>
  logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.area === "audit");

async function structuredOf(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

describe("api_key_create", () => {
  it("returns a claim by default and issues no key", async () => {
    const actor = elevated();
    const client = await connect(await grantToken(actor));
    const result = await structuredOf(client, "api_key_create", { label: " ci runner " });
    const listed = await structuredOf(client, "api_keys_list");
    await client.close();

    const [token] = await gatewayStub.claimTokens();
    expect(result).toEqual({
      status: "claim_ready",
      message:
        "The API key has not been shown to you. Run the command to write it where it belongs, or give the link to a person. The claim works once and expires in 10 minutes; until it is claimed, no key exists.",
      claimUrl: `http://localhost:3000/claim#${token}`,
      command: `secret="$(curl -fsS -X POST 'http://localhost:3000/api/claim' --data-urlencode 'token=${token}')" && printf 'ECCOS_API_KEY=%s\\n' "$secret" >> .env && unset secret`,
      expiresAt: expect.stringMatching(ISO),
    });
    expect((await gatewayStub.calls()).filter((entry) => entry.method === "createSecretClaim").map((entry) => entry.input)).toEqual([
      { request: { kind: "api_key", label: "ci runner" }, creator: { userId: actor.userId, clientId: "client-1" } },
    ]);
    expect(await methods()).not.toContain("issueApiKey");
    expect(listed.keys).toEqual([{ keyId: "key_a1", label: "console", createdAt: "2026-11-01T00:00:00.000Z", revokedAt: null }]);
    expect(listed.pendingClaims).toEqual([
      { kind: "api_key", label: "ci runner", wabaId: null, createdAt: expect.stringMatching(ISO), expiresAt: result.expiresAt, createdByYou: true },
    ]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain(token?.split(".")[0]);
    expect(audits()).toEqual([
      expect.objectContaining({ action: "api_key_create", outcome: "success", resource: { delivery: "claim", claimId: token?.split(".")[0] } }),
    ]);
    expect(logLines.join("\n")).not.toContain(token?.split(".")[1]);
  });

  it("issues the key inline only when asked, and never logs it", async () => {
    const client = await connect(await grantToken(elevated()));
    const result = await structuredOf(client, "api_key_create", { label: "edge", delivery: "inline" });
    await client.close();

    expect(result).toEqual({
      status: "issued",
      message:
        "This is the only time the key is shown. Store it where the /v1 client reads it (for example ECCOS_API_KEY in .env), send it as Authorization: Bearer <key>, and do not repeat it in the conversation.",
      keyId: expect.stringMatching(/^key_[0-9a-f]{32}$/),
      apiKey: expect.stringMatching(/^ek_/),
    });
    expect((await gatewayStub.calls()).filter((entry) => entry.method === "issueApiKey").map((entry) => entry.input)).toEqual([{ label: "edge" }]);
    expect(await methods()).not.toContain("createSecretClaim");
    expect(audits()[0]).toMatchObject({ outcome: "success", resource: { delivery: "inline", keyId: result.keyId } });
    expect(logLines.join("\n")).not.toContain(result.apiKey as string);
  });

  it("says what to do when the account holds 20 pending claims", async () => {
    await seed("acct-a", [], pendingClaims("acct-a", 20));
    const client = await connect(await grantToken(elevated()));
    const text = errorOf(await call(client, "api_key_create"));
    await client.close();

    expect(text).toBe(
      "No key and no claim was made. This workspace already has 20 unclaimed secrets, the most Eccos holds; each works once and expires 10 minutes after it was made, so try again once one is claimed or has expired. Call api_keys_list to see them under pendingClaims, with when each expires.",
    );
    expect(await methods()).not.toContain("issueApiKey");
    expect(audits()[0]).toMatchObject({ outcome: "failed", detail: "too_many_pending", resource: { delivery: "claim" } });
  });

  it("asks for approval without an elevation, and makes nothing", async () => {
    const client = await connect(await grantToken(makeActor()));
    const result = await call(client, "api_key_create", { delivery: "inline" });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "approval_required",
      message: expect.stringContaining("call api_key_create again with the same arguments"),
      retry: { tool: "api_key_create", when: "after_approval", sameArguments: true },
    });
    expect(await gatewayStub.calls()).toEqual([]);
  });

  it("runs after the person approves through URL elicitation, and the prompt carries no secret", async () => {
    const actor = makeActor();
    let elicited = "";
    const client = await connect(await grantToken(actor), {
      capabilities: { elicitation: { url: {} } },
      onElicit: async (params) => {
        elicited = JSON.stringify(params);
        await consoleStub.approve(actor, Date.now() + 86_400_000);
        return { action: "accept" };
      },
    });
    const result = await structuredOf(client, "api_key_create");
    await client.close();

    expect(result).toMatchObject({ status: "claim_ready" });
    expect(elicited).toContain("https://console.example.test/agents/approve?request=");
    const [token] = await gatewayStub.claimTokens();
    expect(elicited).not.toContain(token);
  });

  it("is not listed without administer, and challenges a grant without eccos:administer", async () => {
    const client = await connect(await grantToken(elevated({ actions: ["view", "operate", "send", "configure"] })));
    const names = await listedTools(client);
    await client.close();
    expect(names.filter((name) => name.startsWith("api_key"))).toEqual([]);

    for (const tool of ["api_key_create", "api_keys_list", "api_key_revoke"]) {
      const response = await postMcp(toolsCall(tool, { keyId: "key_a1" }), { token: await grantToken(elevated(), ["eccos:view", "eccos:configure"]) });
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer realm="OAuth", error="insufficient_scope", scope="eccos:administer", resource_metadata="${METADATA_URL}"`,
      );
    }
    expect(await gatewayStub.calls()).toEqual([]);
  });
});

describe("api_keys_list", () => {
  it("lists keys, and pending claims of both kinds without their tokens", async () => {
    const actor = elevated();
    await seed("acct-a", [
      { keyId: "key_a1", label: "console", createdAt: Date.UTC(2026, 10, 1), revokedAt: Date.UTC(2026, 10, 2) },
      { keyId: "key_a2", label: null, createdAt: Date.UTC(2026, 10, 3), revokedAt: null },
    ]);
    const client = await connect(await grantToken(actor));
    await structuredOf(client, "webhook_set", { url: "https://hooks.example.test/x", secret: "generate" });
    const listed = await structuredOf(client, "api_keys_list");
    await client.close();

    expect(listed).toEqual({
      keys: [
        { keyId: "key_a1", label: "console", createdAt: "2026-11-01T00:00:00.000Z", revokedAt: "2026-11-02T00:00:00.000Z" },
        { keyId: "key_a2", label: null, createdAt: "2026-11-03T00:00:00.000Z", revokedAt: null },
      ],
      pendingClaims: [
        { kind: "subscriber_secret", label: null, wabaId: "waba-1", createdAt: expect.stringMatching(ISO), expiresAt: expect.stringMatching(ISO), createdByYou: true },
      ],
      detail: "1 active key, 1 revoked, 1 pending claim.",
      nextTool: null,
    });
    const [token] = await gatewayStub.claimTokens();
    expect(JSON.stringify(listed)).not.toContain(token?.split(".")[1]);
  });

  it("points at api_key_create when no key is active", async () => {
    await seed("acct-a", []);
    const client = await connect(await grantToken(makeActor()));
    const listed = await structuredOf(client, "api_keys_list");
    await client.close();

    expect(listed).toMatchObject({ keys: [], pendingClaims: [], detail: "0 active keys, 0 revoked, 0 pending claims. Call api_key_create to make one for the /v1 API.", nextTool: "api_key_create" });
    expect(await methods()).toEqual(["listApiKeys", "listSecretClaims"]);
  });
});

describe("api_key_revoke", () => {
  it("revokes one of the workspace's keys, once", async () => {
    const client = await connect(await grantToken(elevated()));
    const result = await structuredOf(client, "api_key_revoke", { keyId: "key_a1" });
    const again = errorOf(await call(client, "api_key_revoke", { keyId: "key_a1" }));
    await client.close();

    expect(result).toEqual({ status: "revoked", keyId: "key_a1", message: "Key key_a1 is revoked: the /v1 API refuses it from now on." });
    expect(again).toBe("This workspace has no active key key_a1: it may be revoked already. Call api_keys_list to see its keys.");
    expect(audits()).toEqual([
      expect.objectContaining({ action: "api_key_revoke", outcome: "success", resource: { keyId: "key_a1" }, accountId: "acct-a", clientId: "client-1" }),
      expect.objectContaining({ action: "api_key_revoke", outcome: "failed", detail: "not_found", resource: { keyId: "key_a1" } }),
    ]);
  });

  it("refuses a key itself in place of its id, without repeating or logging it", async () => {
    const pasted = "ek_8NnZb3t3pXyQ9mR2vW6sK1cD4fH7jL0aE5gU";
    const client = await connect(await grantToken(elevated()));
    const result = await call(client, "api_key_revoke", { keyId: pasted });
    await client.close();

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(pasted);
    expect(logLines.join("\n")).not.toContain(pasted);
    expect(await methods()).not.toContain("revokeApiKey");
  });

  it("asks for approval without an elevation, and runs after URL elicitation", async () => {
    const asking = await connect(await grantToken(makeActor()));
    const asked = await call(asking, "api_key_revoke", { keyId: "key_a1" });
    await asking.close();
    expect(asked.isError).toBe(true);
    expect(asked.structuredContent).toMatchObject({ status: "approval_required", retry: { tool: "api_key_revoke" } });
    expect(await gatewayStub.calls()).toEqual([]);

    const actor = makeActor();
    const client = await connect(await grantToken(actor), {
      capabilities: { elicitation: { url: {} } },
      onElicit: async () => {
        await consoleStub.approve(actor, Date.now() + 86_400_000);
        return { action: "accept" };
      },
    });
    expect(await structuredOf(client, "api_key_revoke", { keyId: "key_a1" })).toMatchObject({ status: "revoked" });
    await client.close();
  });
});

describe("api key tools: two accounts", () => {
  beforeEach(async () => {
    await seed("acct-b", [{ keyId: "key_b1", label: "b-private", createdAt: 1, revokedAt: null }], pendingClaims("acct-b", 3));
  });

  it("refuses account B's key id and leaves it working", async () => {
    const client = await connect(await grantToken(elevated()));
    const text = errorOf(await call(client, "api_key_revoke", { keyId: "key_b1" }));
    await client.close();

    expect(text).toBe("This workspace has no active key key_b1: it may be revoked already. Call api_keys_list to see its keys.");
    expect(text).not.toMatch(/acct-b|b-private/);
    const calls = await gatewayStub.calls();
    expect(calls.map((entry) => [entry.method, entry.accountId])).toEqual([["revokeApiKey", "acct-a"]]);

    const owner = await connect(await grantToken(elevated({ organizationId: "org-b", accountId: "acct-b" })));
    const listed = await structuredOf(owner, "api_keys_list");
    await owner.close();
    expect(listed.keys).toEqual([expect.objectContaining({ keyId: "key_b1", revokedAt: null })]);
  });

  it("lists, creates and issues for account A only", async () => {
    const client = await connect(await grantToken(elevated()));
    const listed = await structuredOf(client, "api_keys_list");
    await structuredOf(client, "api_key_create", { label: "a" });
    await structuredOf(client, "api_key_create", { delivery: "inline" });
    await client.close();

    expect(JSON.stringify(listed)).not.toMatch(/key_b1|b-private|label-/);
    expect(listed.pendingClaims).toEqual([]);
    const calls = await gatewayStub.calls();
    expect(calls.map((entry) => entry.method)).toEqual(["listApiKeys", "listSecretClaims", "createSecretClaim", "issueApiKey"]);
    expect(calls.every((entry) => entry.accountId === "acct-a")).toBe(true);
  });
});
