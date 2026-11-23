import { fromJsonSchema } from "@modelcontextprotocol/client";
import type { Client } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureApp } from "./fixtures";
import { connect, consoleStub, envelope, grantToken, makeActor, postMcp, resetStubs } from "./helpers";
import type { Mode } from "./helpers";

beforeEach(resetStubs);

const ARGS = { wabaId: "waba-1", secretValue: "s3cret-value" };
const APPROVAL_URL = /^https:\/\/console\.example\.test\/agents\/approve\?request=[0-9a-f-]{36}$/;

async function outputSchemaOf(client: Client, name: string) {
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool?.outputSchema) throw new Error(`${name} has no output schema`);
  return tool.outputSchema;
}

async function validates(client: Client, name: string, value: unknown): Promise<boolean> {
  const result = await fromJsonSchema(await outputSchemaOf(client, name))["~standard"].validate(value);
  return !("issues" in result && result.issues);
}

const textOf = (result: { content?: unknown }) => {
  const [block] = (result.content ?? []) as { type: string; text: string }[];
  return block?.type === "text" ? JSON.parse(block.text) : undefined;
};

describe("structured approval result", () => {
  it.each<[string, Mode]>([
    ["2026-07-28", { pin: "2026-07-28" }],
    ["2025-11-25", "legacy"],
  ])("tells a %s client without URL elicitation how to get approval", async (_label, mode) => {
    const actor = makeActor();
    const client = await connect(await grantToken(actor), { target: fixtureApp, mode });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "approval_required",
      reason: "elevation_required",
      message:
        "A person must approve sensitive actions for this agent. Ask them to open the link, then call fixture_secret_rotate again with the same arguments.",
      approvalUrl: expect.stringMatching(APPROVAL_URL),
      expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      retry: { tool: "fixture_secret_rotate", when: "after_approval", sameArguments: true },
    });
    expect(textOf(result)).toEqual(result.structuredContent);
    expect(await validates(client, "fixture_secret_rotate", result.structuredContent)).toBe(true);
    expect(await consoleStub.elevationCalls()).toEqual([
      {
        actor: { userId: actor.userId, organizationId: actor.organizationId, accountId: actor.accountId, clientId: actor.clientId },
        tool: "fixture_secret_rotate",
      },
    ]);
    await client.close();
  });

  it("carries the same approval URL on every call while the request is pending", async () => {
    const client = await connect(await grantToken(makeActor()), { target: fixtureApp });
    const urls = new Set<unknown>();
    for (let i = 0; i < 5; i++) {
      const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });
      urls.add((result.structuredContent as { approvalUrl: string }).approvalUrl);
    }
    await client.close();

    expect(urls.size).toBe(1);
  });

  it("runs the tool while the grant is elevated", async () => {
    const client = await connect(await grantToken(makeActor({ elevatedUntil: Date.now() + 3_600_000 })), {
      target: fixtureApp,
    });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "rotated", wabaId: "waba-1" });
    expect(textOf(result)).toEqual(result.structuredContent);
    expect(await consoleStub.elevationCalls()).toEqual([]);
  });

  it("does not run when authorize reports an elevation that has already lapsed", async () => {
    const client = await connect(await grantToken(makeActor({ elevatedUntil: Date.now() - 1 })), { target: fixtureApp });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "approval_required" });
    expect(result.structuredContent).not.toMatchObject({ status: "rotated" });
  });

  it("explains a refused approval request and runs nothing", async () => {
    await consoleStub.refuseElevation({ ok: false, code: "forbidden" });
    const client = await connect(await grantToken(makeActor()), { target: fixtureApp, capabilities: { elicitation: { url: {} } } });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });
    await client.close();

    expect(result.structuredContent).toBeUndefined();
    expect({ isError: result.isError, content: result.content }).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Only an owner or admin of this workspace can approve sensitive actions, and the person this agent acts for is neither. Ask an owner or admin to do this in the Eccos console.",
        },
      ],
    });
  });
});

describe("URL-mode elicitation", () => {
  const urlCapable = { elicitation: { url: {} } };

  it("declined: ends the call with elevation_declined", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = await connect(await grantToken(makeActor()), {
      target: fixtureApp,
      capabilities: urlCapable,
      onElicit: async (params) => {
        seen.push(params);
        return { action: "decline" };
      },
    });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });

    expect(seen).toEqual([
      {
        mode: "url",
        url: expect.stringMatching(APPROVAL_URL),
        message: "Approve sensitive actions for this agent in the Eccos console, then come back here.",
      },
    ]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "elevation_declined",
      action: "decline",
      message:
        "The person declined to approve sensitive actions for this agent. Do not retry fixture_secret_rotate unless they ask you to; calling it again asks for approval again.",
    });
    expect(textOf(result)).toEqual(result.structuredContent);
    expect(await validates(client, "fixture_secret_rotate", result.structuredContent)).toBe(true);
    await client.close();
  });

  it("cancelled: ends the call as cancelled, with its own message", async () => {
    const client = await connect(await grantToken(makeActor()), {
      target: fixtureApp,
      capabilities: urlCapable,
      onElicit: async () => ({ action: "cancel" }),
    });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "elevation_declined",
      action: "cancel",
      message:
        "The person closed the approval prompt without answering. Call fixture_secret_rotate again with the same arguments when they are ready to approve.",
    });
    expect(await validates(client, "fixture_secret_rotate", result.structuredContent)).toBe(true);
    await client.close();
  });

  it("accepted without approving: answers with the structured result, not a second prompt", async () => {
    let prompts = 0;
    const client = await connect(await grantToken(makeActor()), {
      target: fixtureApp,
      capabilities: urlCapable,
      onElicit: async () => {
        prompts += 1;
        return { action: "accept" };
      },
    });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });
    await client.close();

    expect(prompts).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "approval_required", approvalUrl: expect.stringMatching(APPROVAL_URL) });
  });

  it("approved: the retry runs the tool", async () => {
    const actor = makeActor();
    let approvalUrl: unknown;
    const client = await connect(await grantToken(actor), {
      target: fixtureApp,
      capabilities: urlCapable,
      onElicit: async (params) => {
        approvalUrl = params.url;
        await consoleStub.approve(actor, Date.now() + 86_400_000);
        return { action: "accept" };
      },
    });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });
    await client.close();

    expect(approvalUrl).toMatch(APPROVAL_URL);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "rotated", wabaId: "waba-1" });
  });

  it("a 2025-era client that declares URL elicitation still gets the structured result", async () => {
    let prompts = 0;
    const client = await connect(await grantToken(makeActor()), {
      target: fixtureApp,
      mode: "legacy",
      capabilities: urlCapable,
      onElicit: async () => {
        prompts += 1;
        return { action: "accept" };
      },
    });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });
    await client.close();

    expect(prompts).toBe(0);
    expect(result.structuredContent).toMatchObject({ status: "approval_required" });
  });
});

/** The JSON-RPC message a raw POST answered with, as JSON or as the first SSE event. */
async function rpc(response: Response): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(data?.slice(5) ?? "null");
}

const urlEnvelope = () => ({
  ...envelope(),
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } },
});

const rawCall = (name: string, extra: Record<string, unknown> = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: ARGS, _meta: urlEnvelope(), ...extra },
});

/** First round trip: the prompt and the state sealed for `name`. */
async function prompt(token: string, name = "fixture_secret_rotate") {
  const { result } = await rpc(await postMcp(rawCall(name), { token, target: fixtureApp }));
  expect(result).toMatchObject({ resultType: "input_required", requestState: expect.any(String) });
  return result?.requestState as string;
}

const declined = { elevation: { action: "decline" } };

describe("sealed requestState", () => {
  it("an honest round trip: the state minted for the prompt is accepted on the retry", async () => {
    const token = await grantToken(makeActor());
    const requestState = await prompt(token);
    const { result } = await rpc(
      await postMcp(rawCall("fixture_secret_rotate", { requestState, inputResponses: declined }, 2), { token, target: fixtureApp }),
    );

    expect(result?.structuredContent).toMatchObject({ status: "elevation_declined", action: "decline" });
  });

  it("refuses a forged state with -32602 before the tool runs", async () => {
    const token = await grantToken(makeActor());
    await prompt(token);
    const forged = btoa(JSON.stringify({ requestId: "anything", tool: "fixture_secret_rotate" }));
    const elevations = (await consoleStub.elevationCalls()).length;
    const answer = await rpc(
      await postMcp(rawCall("fixture_secret_rotate", { requestState: forged, inputResponses: declined }, 2), { token, target: fixtureApp }),
    );

    expect(answer.error?.code).toBe(-32602);
    expect(answer.result).toBeUndefined();
    expect((await consoleStub.elevationCalls()).length).toBe(elevations);
  });

  it("refuses a state another grant minted", async () => {
    const requestState = await prompt(await grantToken(makeActor()));
    const answer = await rpc(
      await postMcp(rawCall("fixture_secret_rotate", { requestState, inputResponses: declined }, 2), {
        token: await grantToken(makeActor()),
        target: fixtureApp,
      }),
    );

    expect(answer.error?.code).toBe(-32602);
  });

  it("refuses a state minted for another tool", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const token = await grantToken(makeActor());
    const requestState = await prompt(token, "fixture_thing_revoke");
    const { result } = await rpc(
      await postMcp(rawCall("fixture_secret_rotate", { requestState, inputResponses: declined }, 2), { token, target: fixtureApp }),
    );
    vi.restoreAllMocks();

    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "This approval prompt does not match a pending approval request for fixture_secret_rotate. Call fixture_secret_rotate again with the same arguments to get a current approval link.",
        },
      ],
    });
    expect(result?.structuredContent).toBeUndefined();
    expect(lines.map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      action: "fixture_secret_rotate",
      outcome: "denied",
      detail: "request_state_mismatch",
    });
  });

  it("refuses a state for a request that is no longer the pending one", async () => {
    const actor = makeActor();
    const token = await grantToken(actor);
    const requestState = await prompt(token);
    // The person approves and the elevation lapses: the next prompt opens a new request.
    await consoleStub.approve(actor, Date.now() - 1);
    await prompt(token);
    const { result } = await rpc(
      await postMcp(rawCall("fixture_secret_rotate", { requestState, inputResponses: declined }, 3), { token, target: fixtureApp }),
    );

    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("does not match a pending approval request") }] });
  });
});

describe("without a sealing key", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const unsealed = { ...env, REQUEST_STATE_KEY: undefined };

  it("never elicits, answers with the structured result, and warns once without the key", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    let prompts = 0;
    const client = await connect(await grantToken(makeActor()), {
      target: fixtureApp,
      bindings: unsealed,
      capabilities: { elicitation: { url: {} } },
      onElicit: async () => {
        prompts += 1;
        return { action: "accept" };
      },
    });
    const result = await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });
    await client.close();

    expect(prompts).toBe(0);
    expect(result.structuredContent).toMatchObject({ status: "approval_required", approvalUrl: expect.stringMatching(APPROVAL_URL) });
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      {
        level: "warn",
        area: "mcp",
        event: "url_elicitation_unavailable",
        tool: "fixture_secret_rotate",
        reason: "REQUEST_STATE_KEY is not set",
      },
    ]);
    expect(warnings.join("\n")).not.toContain((env as unknown as { REQUEST_STATE_KEY: string }).REQUEST_STATE_KEY);
  });

  it("does not warn for a client that would not have elicited", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = await connect(await grantToken(makeActor()), { target: fixtureApp, bindings: unsealed });
    await client.callTool({ name: "fixture_secret_rotate", arguments: ARGS });
    await client.close();

    expect(warn).not.toHaveBeenCalled();
  });
});
