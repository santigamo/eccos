import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  METADATA_URL,
  accountResources,
  call,
  connect,
  consoleStub,
  gatewayStub,
  grantToken,
  listedTools,
  makeActor,
  postMcp,
  resetStubs,
  toolsCall,
} from "./helpers";

let infoLines: string[] = [];

beforeEach(async () => {
  await resetStubs();
  await gatewayStub.seed("acct-a", { resources: accountResources("acct-a") });
  infoLines = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    infoLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const elevated = (overrides = {}) => makeActor({ elevatedUntil: Date.now() + 3_600_000, ...overrides });
const LINK_URL = /^http:\/\/localhost:3000\/connect#ecl_[0-9a-f]{32}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

async function create(client: Client, args: Record<string, unknown> = {}) {
  return (await call(client, "connect_link_create", args)).structuredContent as Record<string, unknown>;
}

describe("connect_link_create", () => {
  it("makes the link for a person to open, bound to the acting user, and never logs it", async () => {
    const actor = elevated();
    const client = await connect(await grantToken(actor));
    const result = await call(client, "connect_link_create");
    await client.close();

    expect(result.isError).toBeFalsy();
    const link = result.structuredContent as { url: string };
    expect(link).toEqual({
      status: "created",
      url: expect.stringMatching(LINK_URL),
      state: "pending",
      expiresAt: expect.stringMatching(ISO),
      connectedPhone: null,
      createdByYou: true,
      detail: expect.stringMatching(/^Give this link to the person who manages the business's WhatsApp; they open it in a browser/),
      nextTool: "connect_status",
    });
    expect(await gatewayStub.connectLinkIssues()).toEqual([{ accountId: "acct-a", creatorUserId: actor.userId, replace: false }]);
    const token = link.url.split("#")[1] ?? "";
    expect(infoLines.length).toBeGreaterThan(0);
    expect(infoLines.join("\n")).not.toContain(token);
    expect(infoLines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ area: "audit", action: "connect_link_create", resource: { replace: "false" }, outcome: "success" }),
    ]);
  });

  it("keeps a link that has not expired, and says how to replace it", async () => {
    await gatewayStub.seed("acct-a", {
      resources: accountResources("acct-a"),
      connectLink: { state: "opened", expiresAt: Date.UTC(2026, 10, 30), connectedPhone: null, creatorUserId: "someone-else" },
    });
    const client = await connect(await grantToken(elevated()));
    const link = await create(client);
    await client.close();

    expect(link).toMatchObject({ status: "exists", url: null, state: "opened", createdByYou: false, nextTool: "connect_status" });
    expect(link.detail).toMatch(/its URL was shown only to whoever made it\..*call connect_link_create with replace: true\.$/);
    expect(await gatewayStub.connectLinkIssues()).toEqual([]);
  });

  it("keeps a used link too, as the console does, until replace is passed", async () => {
    await gatewayStub.seed("acct-a", {
      resources: accountResources("acct-a"),
      connectLink: { state: "connected", expiresAt: Date.UTC(2026, 10, 30), connectedPhone: "+34 600 111", creatorUserId: "u" },
    });
    const actor = elevated();
    const client = await connect(await grantToken(actor));
    expect(await create(client)).toMatchObject({ status: "exists", state: "connected", connectedPhone: "+34 600 111" });
    const replaced = await create(client, { replace: true });
    await client.close();

    expect(replaced).toMatchObject({ status: "created", url: expect.stringMatching(LINK_URL), createdByYou: true });
    expect(await gatewayStub.connectLinkIssues()).toEqual([{ accountId: "acct-a", creatorUserId: actor.userId, replace: true }]);
    expect((await gatewayStub.calls()).filter((entry) => entry.method === "getConnectLink")).toHaveLength(1);
  });

  it("makes a new link when the last one expired", async () => {
    await gatewayStub.seed("acct-a", {
      resources: accountResources("acct-a"),
      connectLink: { state: "expired", expiresAt: 1, connectedPhone: null, creatorUserId: "u" },
    });
    const client = await connect(await grantToken(elevated()));
    expect(await create(client)).toMatchObject({ status: "created" });
    await client.close();
  });

  it("asks for approval without an elevation, and makes nothing", async () => {
    const client = await connect(await grantToken(makeActor()));
    const result = await call(client, "connect_link_create");
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "approval_required",
      retry: { tool: "connect_link_create", when: "after_approval", sameArguments: true },
    });
    expect(await gatewayStub.calls()).toEqual([]);
  });

  it("runs after the person approves through URL elicitation", async () => {
    const actor = makeActor();
    const client = await connect(await grantToken(actor), {
      capabilities: { elicitation: { url: {} } },
      onElicit: async () => {
        await consoleStub.approve(actor, Date.now() + 86_400_000);
        return { action: "accept" };
      },
    });
    const link = await create(client);
    await client.close();

    expect(link).toMatchObject({ status: "created", url: expect.stringMatching(LINK_URL) });
    expect(await consoleStub.elevationCalls()).toEqual([expect.objectContaining({ tool: "connect_link_create" })]);
  });

  it("is not listed without administer, and challenges a grant without eccos:administer", async () => {
    const operator = await connect(await grantToken(elevated({ role: "operator", actions: ["view", "operate"] })));
    expect(await listedTools(operator)).not.toContain("connect_link_create");
    await operator.close();

    const token = await grantToken(elevated({ actions: ["view"] }), ["eccos:view"]);
    const response = await postMcp(toolsCall("connect_link_create"), { token });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="OAuth", error="insufficient_scope", scope="eccos:administer", resource_metadata="${METADATA_URL}"`,
    );
    expect(await gatewayStub.connectLinkIssues()).toEqual([]);
  });

  it("makes and reads the link of the actor's own account only", async () => {
    await gatewayStub.seed("acct-b", {
      resources: accountResources("acct-b"),
      connectLink: { state: "pending", expiresAt: Date.UTC(2026, 10, 30), connectedPhone: null, creatorUserId: "user-b" },
    });
    const client = await connect(await grantToken(elevated({ organizationId: "org-a", accountId: "acct-a" })));
    expect(await create(client)).toMatchObject({ status: "created" });
    await client.close();

    expect((await gatewayStub.calls()).every((entry) => entry.accountId === "acct-a")).toBe(true);
    expect((await gatewayStub.connectLinkIssues()).map((issue) => issue.accountId)).toEqual(["acct-a"]);
  });
});

describe("connect_status", () => {
  it("says none and names connect_link_create before any link exists", async () => {
    const client = await connect(await grantToken(makeActor()));
    const result = await call(client, "connect_status");
    await client.close();

    expect(result.structuredContent).toEqual({
      state: "none",
      expiresAt: null,
      connectedPhone: null,
      createdByYou: null,
      detail: "No connection link was ever made for this workspace. Call connect_link_create to make one.",
      nextTool: "connect_link_create",
    });
  });

  it("tells a viewer who can make the link instead of naming a tool it cannot call", async () => {
    const client = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] }), ["eccos:view"]));
    const result = await call(client, "connect_status");
    await client.close();

    expect(result.structuredContent).toMatchObject({
      state: "none",
      detail:
        "No connection link was ever made for this workspace. This connection cannot do the next step: it needs the eccos:administer scope, which an owner or admin can grant, or they can do it in the Eccos console.",
      nextTool: null,
    });
  });

  it.each([
    ["pending", null, "connect_status"],
    ["opened", null, "connect_status"],
    ["connected", "+34 600 111", "numbers_list"],
    ["unconfirmed", null, "numbers_list"],
    ["expired", null, "connect_link_create"],
  ] as const)("reports a %s link and what to call next", async (state, connectedPhone, nextTool) => {
    const actor = makeActor();
    await gatewayStub.seed("acct-a", {
      resources: accountResources("acct-a"),
      connectLink: { state, expiresAt: Date.UTC(2026, 10, 30), connectedPhone, creatorUserId: actor.userId },
    });
    const client = await connect(await grantToken(actor));
    const status = (await call(client, "connect_status")).structuredContent as Record<string, unknown>;
    await client.close();

    expect(status).toMatchObject({ state, expiresAt: "2026-11-30T00:00:00.000Z", connectedPhone, createdByYou: true, nextTool });
    expect(JSON.stringify(status)).not.toMatch(/#|ecl_/);
    if (state === "connected") expect(status.detail).toBe("The link connected +34 600 111. Call numbers_list to follow its setup.");
  });

  it("reads the actor's own account only", async () => {
    await gatewayStub.seed("acct-b", {
      resources: accountResources("acct-b"),
      connectLink: { state: "connected", expiresAt: 1, connectedPhone: "+1 555 0100", creatorUserId: "user-b" },
    });
    const client = await connect(await grantToken(makeActor()));
    const status = (await call(client, "connect_status")).structuredContent;
    await client.close();

    expect(status).toMatchObject({ state: "none" });
    expect((await gatewayStub.calls()).every((entry) => entry.accountId === "acct-a")).toBe(true);
  });
});
