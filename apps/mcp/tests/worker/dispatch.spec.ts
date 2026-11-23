import { beforeEach, describe, expect, it } from "vitest";
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
  it("refuses a browser origin other than the console", async () => {
    const token = await grantToken(makeActor());
    const response = await postMcp(toolsList(), { token, headers: { origin: "https://evil.example" } });

    expect(response.status).toBe(403);
  });

  it("accepts the console origin and requests without one", async () => {
    const token = await grantToken(makeActor());

    expect((await postMcp(toolsList(1), { token, headers: { origin: "https://console.example.test" } })).status).toBe(200);
    expect((await postMcp(toolsList(2), { token })).status).toBe(200);
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
      "connect_link_create",
      "connect_status",
      "fixture_configure",
      "fixture_secret_rotate",
      "number_recheck",
      "numbers_list",
      "status_get",
      "workspace_get",
    ]);
    expect(await names(viewer)).toEqual(["connect_status", "numbers_list", "status_get", "workspace_get"]);
  });

  it("refuses a tool the role does not allow even when the scope is granted", async () => {
    const token = await grantToken(makeActor({ role: "viewer", actions: ["view"] }));
    const client = await connect(token, { target: fixtureApp });
    const outcome = await client.callTool({ name: "fixture_configure", arguments: { wabaId: "waba-1" } }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: String(error) }),
    );
    await client.close();

    expect(outcome).toEqual({ error: expect.stringContaining("fixture_configure") });
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
