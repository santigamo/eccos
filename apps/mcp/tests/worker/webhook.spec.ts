import type { AccountWabaResource, SecretClaim } from "@eccos/gateway-contract";
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
  wabaIn,
} from "./helpers";

let logLines: string[] = [];

beforeEach(async () => {
  await resetStubs();
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
const TARGET = "https://hooks.example.test/eccos";
const elevated = (overrides = {}) => makeActor({ elevatedUntil: Date.now() + 3_600_000, ...overrides });
const operator = () => makeActor({ role: "operator", actions: ["view", "operate"] });

async function seedA(...wabas: AccountWabaResource[]) {
  await gatewayStub.seed("acct-a", {
    resources: accountResources("acct-a", wabas.length > 0 ? wabas : [activeWaba("waba-1", "acct-a", ["111"])]),
    subscriber: {
      "waba-1": {
        url: "https://old.example.test/hook",
        hasSecret: true,
        lastForward: { status: "failed", attempts: 3, createdAt: Date.UTC(2026, 10, 20), finishedAt: Date.UTC(2026, 10, 20, 0, 5), lastError: "HTTP 500" },
      },
    },
  });
}

async function seedB() {
  await gatewayStub.seed("acct-b", { resources: accountResources("acct-b", [activeWaba("waba-b", "acct-b", ["900"])]) });
}

const writes = async (method: string) => (await gatewayStub.calls()).filter((entry) => entry.method === method);
const audits = () =>
  logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.area === "audit");

async function structuredOf(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

describe("webhook_get", () => {
  it("returns the target, whether a secret is set and the last forward, to an operator", async () => {
    await seedA();
    const client = await connect(await grantToken(operator(), ["eccos:view", "eccos:operate"]));
    const result = await structuredOf(client, "webhook_get");
    await client.close();

    expect(result).toEqual({
      wabaId: "waba-1",
      url: "https://old.example.test/hook",
      hasSecret: true,
      lastForward: {
        status: "failed",
        attempts: 3,
        createdAt: "2026-11-20T00:00:00.000Z",
        finishedAt: "2026-11-20T00:05:00.000Z",
        lastError: "HTTP 500",
      },
      detail: "Events are forwarded to this URL, signed in the x-eccos-signature header.",
      nextTool: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret"\s*:\s*"/i);
  });

  it("points at webhook_set when no target is set, only for a connection that may call it", async () => {
    await gatewayStub.seed("acct-a", { resources: accountResources("acct-a", [activeWaba("waba-1", "acct-a", ["111"])]) });
    const owner = await connect(await grantToken(makeActor()));
    expect(await structuredOf(owner, "webhook_get")).toMatchObject({ url: null, hasSecret: false, lastForward: null, nextTool: "webhook_set" });
    await owner.close();

    const client = await connect(await grantToken(operator(), ["eccos:view", "eccos:operate"]));
    const result = await structuredOf(client, "webhook_get");
    await client.close();
    expect(result).toMatchObject({ nextTool: null, detail: expect.stringMatching(/configure needs an admin or above/) });
  });

  it("is not listed for a viewer, and challenges a grant without eccos:operate", async () => {
    await seedA();
    const viewer = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] })));
    expect(await listedTools(viewer)).not.toContain("webhook_get");
    await viewer.close();

    const response = await postMcp(toolsCall("webhook_get"), { token: await grantToken(makeActor(), ["eccos:view"]) });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="OAuth", error="insufficient_scope", scope="eccos:operate", resource_metadata="${METADATA_URL}"`,
    );
    expect(await gatewayStub.calls()).toEqual([]);
  });
});

describe("webhook_set", () => {
  it("generates the secret by claim: the URL is stored without a secret, and the result carries only the claim", async () => {
    await seedA();
    const actor = elevated();
    const client = await connect(await grantToken(actor));
    const result = await structuredOf(client, "webhook_set", { url: TARGET, secret: "generate" });
    await client.close();

    const [token] = await gatewayStub.claimTokens();
    expect(token).toMatch(/^[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{43}$/);
    expect(result).toEqual({
      status: "claim_ready",
      wabaId: "waba-1",
      url: TARGET,
      secret: "claim_pending",
      message: expect.stringMatching(/^The signing secret has not been shown to you\. Run the command .* or give the link to a person\. The claim works once and expires in 10 minutes; until it is claimed, no new secret exists/),
      claimUrl: `http://localhost:3000/claim#${token}`,
      command: `secret="$(curl -fsS -X POST 'http://localhost:3000/api/claim' --data-urlencode 'token=${token}')" && printf 'ECCOS_WEBHOOK_SECRET=%s\\n' "$secret" >> .env && unset secret`,
      expiresAt: expect.stringMatching(ISO),
    });
    expect((await writes("setSubscriberConfig")).map((entry) => entry.input)).toEqual([{ url: TARGET }]);
    expect((await writes("createSecretClaim")).map((entry) => entry.input)).toEqual([
      { request: { kind: "subscriber_secret", wabaId: "waba-1" }, creator: { userId: actor.userId, clientId: "client-1" } },
    ]);
    const [audit] = audits();
    expect(audit).toMatchObject({ action: "webhook_set", outcome: "success", resource: { wabaId: "waba-1", secret: "generate", claimId: token?.split(".")[0] } });
    expect(logLines.join("\n")).not.toContain(token);
    expect(logLines.join("\n")).not.toContain(token?.split(".")[1]);
  });

  it.each([
    [{}, { url: TARGET }, "kept", "The signing secret is unchanged."],
    [{ secret: "keep" }, { url: TARGET }, "kept", "The signing secret is unchanged."],
    [{ secret: "remove" }, { url: TARGET, secret: null }, "removed", "The signing secret was removed: forwards now go unsigned."],
    [{ secretValue: "  customer-own-secret-7f3a  " }, { url: TARGET, secret: "customer-own-secret-7f3a" }, "replaced", "The signing secret was replaced with the value you passed."],
  ])("maps %j to the console's write", async (args, write, outcome, said) => {
    await seedA();
    const client = await connect(await grantToken(elevated()));
    const result = await structuredOf(client, "webhook_set", { url: TARGET, ...args });
    await client.close();

    expect(result).toEqual({ status: "saved", wabaId: "waba-1", url: TARGET, secret: outcome, message: `Saved: events are forwarded to ${TARGET}. ${said}` });
    expect((await writes("setSubscriberConfig")).map((entry) => entry.input)).toEqual([write]);
    expect(await writes("createSecretClaim")).toEqual([]);
    expect(logLines.join("\n")).not.toContain("customer-own-secret-7f3a");
    expect(audits()[0]?.resource).toEqual({ wabaId: "waba-1", secret: "secretValue" in args ? "value" : ((args as { secret?: string }).secret ?? "keep") });
  });

  it("refuses secret and secretValue together, and writes nothing", async () => {
    await seedA();
    const client = await connect(await grantToken(elevated()));
    const text = errorOf(await call(client, "webhook_set", { url: TARGET, secret: "keep", secretValue: "hush-hush-1234" }));
    await client.close();

    expect(text).toBe("Pass either secret or secretValue, not both. Call webhook_set again with one of them.");
    expect(await writes("setSubscriberConfig")).toEqual([]);
    expect(logLines.join("\n")).not.toContain("hush-hush-1234");
  });

  it("says why the gateway refused the URL", async () => {
    await seedA();
    const client = await connect(await grantToken(elevated()));
    const text = errorOf(await call(client, "webhook_set", { url: "http://hooks.example.test/eccos", secret: "generate" }));
    await client.close();

    expect(text).toBe(
      "Eccos refused the URL: it must use https. Forwarding needs a public https URL without a user name or password. Fix it and call webhook_set again.",
    );
    expect(await writes("createSecretClaim")).toEqual([]);
    expect(audits()[0]).toMatchObject({ outcome: "failed", detail: "invalid_url" });
  });

  it("says what to do when the account holds 20 pending claims, after saving the URL", async () => {
    const now = Date.now();
    const claims: SecretClaim[] = Array.from({ length: 20 }, (_, index) => ({
      claimId: `claim${String(index).padStart(6, "0")}`,
      accountId: "acct-a",
      organizationId: "org-a",
      creatorUserId: "someone",
      clientId: "client-1",
      createdAt: now,
      expiresAt: now + 600_000,
      kind: "api_key",
      label: null,
    }));
    await gatewayStub.seed("acct-a", { resources: accountResources("acct-a", [activeWaba("waba-1", "acct-a", ["111"])]), claims });
    const client = await connect(await grantToken(elevated()));
    const text = errorOf(await call(client, "webhook_set", { url: TARGET, secret: "generate" }));
    await client.close();

    expect(text).toBe(
      "The URL was saved, but no new signing secret was made, so forwards are signed as before. This workspace already has 20 unclaimed secrets, the most Eccos holds; each works once and expires 10 minutes after it was made, so try again once one is claimed or has expired. Call api_keys_list to see them under pendingClaims, with when each expires.",
    );
    expect((await writes("setSubscriberConfig")).map((entry) => entry.input)).toEqual([{ url: TARGET }]);
    expect(audits()[0]).toMatchObject({ outcome: "failed", detail: "too_many_pending", resource: { wabaId: "waba-1", secret: "generate" } });
  });

  it("does not name api_keys_list to a connection without administer", async () => {
    const now = Date.now();
    const claims = Array.from({ length: 20 }, (_, index) => ({
      claimId: `c${index}`,
      accountId: "acct-a",
      organizationId: "org-a",
      creatorUserId: "someone",
      clientId: "client-1",
      createdAt: now,
      expiresAt: now + 600_000,
      kind: "api_key" as const,
      label: null,
    }));
    await gatewayStub.seed("acct-a", { resources: accountResources("acct-a", [activeWaba("waba-1", "acct-a", ["111"])]), claims });
    const client = await connect(await grantToken(elevated({ actions: ["view", "configure"] }), ["eccos:view", "eccos:configure"]));
    const text = errorOf(await call(client, "webhook_set", { url: TARGET, secret: "generate" }));
    await client.close();

    expect(text).not.toContain("api_keys_list");
    expect(text).toMatch(/not granted the eccos:administer scope/);
  });

  it("asks for approval without an elevation, and writes nothing", async () => {
    await seedA();
    const client = await connect(await grantToken(makeActor()));
    const result = await call(client, "webhook_set", { url: TARGET, secretValue: "never-logged-value" });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "approval_required", retry: { tool: "webhook_set", when: "after_approval", sameArguments: true } });
    expect(await gatewayStub.calls()).toEqual([]);
    expect(logLines.join("\n")).not.toContain("never-logged-value");
  });

  it("runs after the person approves through URL elicitation", async () => {
    await seedA();
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
    const result = await structuredOf(client, "webhook_set", { url: TARGET, secret: "generate" });
    await client.close();

    expect(result).toMatchObject({ status: "claim_ready" });
    expect(await consoleStub.elevationCalls()).toEqual([expect.objectContaining({ tool: "webhook_set" })]);
    const [token] = await gatewayStub.claimTokens();
    expect(elicited).not.toContain(token);
    expect(elicited).not.toContain(TARGET);
  });

  it("is not listed for an operator, and challenges a grant without eccos:configure", async () => {
    await seedA();
    const client = await connect(await grantToken(elevated({ role: "operator", actions: ["view", "operate"] })));
    expect(await listedTools(client)).not.toContain("webhook_set");
    await client.close();

    const response = await postMcp(toolsCall("webhook_set", { url: TARGET }), { token: await grantToken(elevated(), ["eccos:view", "eccos:administer"]) });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope", scope="eccos:configure"');
    expect(await gatewayStub.calls()).toEqual([]);
  });
});

describe("webhook_resubscribe", () => {
  it("redoes the Meta subscription of the only WABA", async () => {
    await seedA();
    const client = await connect(await grantToken(elevated()));
    const result = await structuredOf(client, "webhook_resubscribe");
    await client.close();

    expect(result).toEqual({ status: "resubscribed", wabaId: "waba-1", message: "Meta confirmed that WABA waba-1 sends its events to Eccos." });
    expect((await gatewayStub.calls()).map((entry) => entry.method)).toEqual(["listAccountResources", "resubscribe"]);
    expect(audits()[0]).toMatchObject({ action: "webhook_resubscribe", outcome: "success", resource: { wabaId: "waba-1" } });
  });

  it("sends a WABA still being set up to number_recheck, as the console only resubscribes an active one", async () => {
    await seedA(wabaIn("pending", "waba-1", "acct-a", ["111"]));
    const client = await connect(await grantToken(elevated()));
    const text = errorOf(await call(client, "webhook_resubscribe"));
    await client.close();

    expect(text).toBe(
      "WABA waba-1 is pending, not active, so there is no subscription to redo. Call number_recheck to finish its setup, which subscribes it.",
    );
    expect(await writes("resubscribe")).toEqual([]);
  });

  it("does not repeat Meta's error text", async () => {
    await gatewayStub.seed("acct-a", {
      resources: accountResources("acct-a", [activeWaba("waba-1", "acct-a", ["111"])]),
      resubscribe: { "waba-1": { ok: false, error: "Error: (#100) access_token=EAAB-secret-ish" } },
    });
    const client = await connect(await grantToken(elevated()));
    const text = errorOf(await call(client, "webhook_resubscribe"));
    await client.close();

    expect(text).toBe(
      "Meta did not accept the subscription for WABA waba-1 just now. Call webhook_resubscribe again in a few minutes; if it keeps failing, the person should contact Eccos support.",
    );
    expect(logLines.join("\n")).not.toContain("EAAB");
    expect(audits()[0]).toMatchObject({ outcome: "failed", detail: "resubscribe_failed" });
  });

  it("asks for approval without an elevation, and runs after URL elicitation", async () => {
    await seedA();
    const structuredClient = await connect(await grantToken(makeActor()));
    const asked = await call(structuredClient, "webhook_resubscribe");
    await structuredClient.close();
    expect(asked.isError).toBe(true);
    expect(asked.structuredContent).toMatchObject({ status: "approval_required", retry: { tool: "webhook_resubscribe" } });
    expect(await gatewayStub.calls()).toEqual([]);

    const actor = makeActor();
    const client = await connect(await grantToken(actor), {
      capabilities: { elicitation: { url: {} } },
      onElicit: async () => {
        await consoleStub.approve(actor, Date.now() + 86_400_000);
        return { action: "accept" };
      },
    });
    expect(await structuredOf(client, "webhook_resubscribe")).toMatchObject({ status: "resubscribed" });
    await client.close();
  });

  it("challenges a grant without eccos:configure", async () => {
    const response = await postMcp(toolsCall("webhook_resubscribe"), { token: await grantToken(elevated(), ["eccos:view"]) });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('scope="eccos:configure"');
  });
});

describe("webhook tools: two accounts", () => {
  it.each([
    ["webhook_get", { wabaId: "waba-b" }],
    ["webhook_set", { wabaId: "waba-b", url: TARGET, secret: "generate" }],
    ["webhook_set", { wabaId: "waba-b", url: TARGET, secretValue: "b-secret-value" }],
    ["webhook_resubscribe", { wabaId: "waba-b" }],
  ])("refuses %s with account B's WABA and never calls the gateway for B", async (name, args) => {
    await seedA();
    await seedB();
    const client = await connect(await grantToken(elevated()));
    const text = errorOf(await call(client, name, args));
    await client.close();

    expect(text).toBe("WABA waba-b is not connected to this workspace. Its WABAs are: waba-1. Call numbers_list to see them.");
    const calls = await gatewayStub.calls();
    expect(calls.map((entry) => entry.method)).toEqual(["listAccountResources"]);
    expect(calls.every((entry) => entry.accountId === "acct-a")).toBe(true);
    expect(logLines.join("\n")).not.toContain("b-secret-value");
  });
});
