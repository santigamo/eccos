import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mode } from "./helpers";
import { fixtureApp } from "./fixtures";
import {
  METADATA_URL,
  connect,
  consoleStub,
  grantToken,
  makeActor,
  postMcp,
  resetStubs,
  toolsCall,
  toolsList,
} from "./helpers";

beforeEach(resetStubs);

const names = async (token: string) => {
  const client = await connect(token, { target: fixtureApp });
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name).sort();
};

describe("origin", () => {
  // wrangler.vitest.jsonc: CONSOLE_ORIGIN is http://localhost:3000.
  it.each(["https://evil.example", "http://localhost:9999", "https://localhost", "http://localhost", "null"])(
    "refuses the browser origin %s",
    async (origin) => {
      const token = await grantToken(makeActor());
      const response = await postMcp(toolsList(), { token, headers: { origin } });

      expect(response.status).toBe(403);
    },
  );

  it("accepts the console origin and requests without one", async () => {
    const token = await grantToken(makeActor());

    expect((await postMcp(toolsList(1), { token, headers: { origin: "http://localhost:3000" } })).status).toBe(200);
    expect((await postMcp(toolsList(2), { token })).status).toBe(200);
  });
});

describe("body cap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every way this Worker could parse a body: JSON.parse on text, or Request.json. */
  const parsers = () => {
    const parse = vi.spyOn(JSON, "parse");
    const json = vi.spyOn(Request.prototype, "json");
    return () => parse.mock.calls.length + json.mock.calls.length;
  };

  const oversized = () => JSON.stringify(toolsCall("workspace_get", { padding: "x".repeat(4 * 1024 * 1024) }));

  it("refuses a body over 4 MiB by Content-Length before parsing it", async () => {
    const token = await grantToken(makeActor());
    const body = oversized();
    const parsed = parsers();
    const response = await postMcp(undefined, { token, raw: body, headers: { "content-length": String(body.length) } });
    const calls = parsed();

    expect(response.status).toBe(413);
    expect(calls).toBe(0);
  });

  it("refuses a chunked body over 4 MiB while reading it, before parsing it", async () => {
    const token = await grantToken(makeActor());
    const bytes = new TextEncoder().encode(oversized());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) controller.enqueue(bytes.slice(offset, offset + 64 * 1024));
        controller.close();
      },
    });
    const parsed = parsers();
    const response = await postMcp(undefined, { token, raw: stream });
    const calls = parsed();

    expect(response.status).toBe(413);
    expect(calls).toBe(0);
  });
});

describe("scope challenge", () => {
  it("answers 403 insufficient_scope naming the scope a known tool needs", async () => {
    const actor = makeActor({ actions: ["view"] });
    const token = await grantToken(actor, ["eccos:view"]);
    const response = await postMcp(toolsCall("fixture_configure", { wabaId: "waba-1" }), { token, target: fixtureApp });

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="OAuth", error="insufficient_scope", scope="eccos:configure", resource_metadata="${METADATA_URL}"`,
    );
  });

  it("challenges workspace_get for eccos:view when the grant lacks it", async () => {
    const actor = makeActor({ actions: ["operate"] });
    const token = await grantToken(actor, ["eccos:operate"]);
    const response = await postMcp(toolsCall("workspace_get"), { token });

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('scope="eccos:view"');
  });

  it("leaves an unknown tool to the MCP server", async () => {
    const token = await grantToken(makeActor());
    const response = await postMcp(toolsCall("no_such_tool"), { token, target: fixtureApp });

    expect(response.status).toBe(200);
  });
});

describe("effective permissions", () => {
  it("lists only the tools whose action the actor has", async () => {
    const owner = await grantToken(makeActor());
    const viewer = await grantToken(makeActor({ role: "viewer", actions: ["view"] }));

    expect(await names(owner)).toEqual([
      "billing_checkout_link",
      "billing_get",
      "connect_link_create",
      "connect_status",
      "fixture_configure",
      "fixture_secret_rotate",
      "fixture_thing_revoke",
      "number_recheck",
      "numbers_list",
      "status_get",
      "template_create",
      "template_delete",
      "template_edit",
      "template_send_test",
      "templates_list",
      "workspace_get",
    ]);
    expect(await names(viewer)).toEqual(["numbers_list", "status_get", "templates_list", "workspace_get"]);
  });

  it.each<[string, Mode]>([
    ["2026-07-28", { pin: "2026-07-28" }],
    ["2025-11-25", "legacy"],
  ])("tells a %s client what a role lacks when the scope is granted, and audits it", async (_label, mode) => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const actor = makeActor({ role: "viewer", actions: ["view"] });
    const client = await connect(await grantToken(actor), { target: fixtureApp, mode });
    const result = await client.callTool({ name: "fixture_configure", arguments: { wabaId: "waba-1" } });
    await client.close();
    vi.restoreAllMocks();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text: "This connection acts for a viewer, and configure needs an admin or above in this workspace. Ask such a person to do this in the Eccos console.",
      },
    ]);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        level: "info",
        area: "audit",
        via: "mcp",
        action: "fixture_configure",
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        accountId: actor.accountId,
        clientId: actor.clientId,
        resource: null,
        outcome: "denied",
        detail: "forbidden",
      },
    ]);
    expect(await consoleStub.elevationCalls()).toEqual([]);
  });

  it("never offers a tool input that names an account or organization", async () => {
    const client = await connect(await grantToken(makeActor()), { target: fixtureApp });
    const { tools } = await client.listTools();
    await client.close();

    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {}).filter((key) => /account|organi[sz]ation/i.test(key))).toEqual([]);
    }
  });
});
