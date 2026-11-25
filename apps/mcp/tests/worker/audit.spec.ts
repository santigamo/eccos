import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureApp } from "./fixtures";
import { connect, grantToken, makeActor, resetStubs } from "./helpers";

let lines: unknown[][] = [];

beforeEach(async () => {
  await resetStubs();
  lines = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const auditLines = () =>
  lines
    .map(([first]) => (typeof first === "string" ? JSON.parse(first) : first))
    .filter((line) => (line as { area?: string }).area === "audit");

describe("audit", () => {
  it("writes one line per mutating call, with ids and outcome only", async () => {
    const actor = makeActor({ elevatedUntil: Date.now() + 60_000 });
    const token = await grantToken(actor);
    const client = await connect(token, { target: fixtureApp });
    await client.callTool({ name: "fixture_secret_rotate", arguments: { wabaId: "waba-1", secretValue: "s3cret-value" } });
    await client.close();

    expect(auditLines()).toEqual([
      {
        level: "info",
        area: "audit",
        via: "mcp",
        action: "fixture_secret_rotate",
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        accountId: actor.accountId,
        clientId: actor.clientId,
        resource: { wabaId: "waba-1" },
        outcome: "success",
        detail: null,
      },
    ]);
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain("s3cret-value");
    expect(everything).not.toContain(token);
  });

  it("records a failure and a refused step-up", async () => {
    const client = await connect(await grantToken(makeActor()), { target: fixtureApp });
    await client.callTool({ name: "fixture_configure", arguments: { wabaId: "waba-1", fail: true } });
    await client.callTool({ name: "fixture_secret_rotate", arguments: { wabaId: "waba-1", secretValue: "x" } });
    await client.close();

    expect(auditLines().map(({ action, outcome, detail }) => ({ action, outcome, detail }))).toEqual([
      { action: "fixture_configure", outcome: "failed", detail: null },
      { action: "fixture_secret_rotate", outcome: "denied", detail: "elevation_required" },
    ]);
  });

  it("writes nothing for a read-only tool", async () => {
    const client = await connect(await grantToken(makeActor()), { target: fixtureApp });
    await client.callTool({ name: "workspace_get", arguments: {} });
    await client.close();

    expect(auditLines()).toEqual([]);
  });
});
