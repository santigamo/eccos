import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/tools";
import { NEXT_TOOLS, offer } from "../../src/tools/next";
import { type McpActor, type ToolDeps, toolActions } from "../../src/tools/registry";

const actor = { role: "admin" } as McpActor;
const depsFor = (held: string[]) =>
  ({
    can: (action: string) => held.includes(action),
    toolActions: Object.fromEntries(TOOLS.map((tool) => [tool.name, toolActions(tool)])),
  }) as unknown as ToolDeps;

describe("offer", () => {
  it("can point only at tools the registry has", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(NEXT_TOOLS.filter((tool) => !names.includes(tool))).toEqual([]);
  });

  it("names a tool only when the connection holds its action and its reads", () => {
    const call = { tool: "number_recheck", call: "Call number_recheck." } as const;

    expect(offer(depsFor(["view", "configure"]), actor, "Stuck.", call)).toEqual({ detail: "Stuck. Call number_recheck.", nextTool: "number_recheck" });
    expect(offer(depsFor(["configure"]), actor, "Stuck.", call)).toEqual({
      detail: "Stuck. This connection was not granted the eccos:view scope that view needs. Ask the person to connect the agent again and grant it.",
      nextTool: null,
    });
  });

  it("names a tool that reads nothing at view to a connection without view", () => {
    expect(offer(depsFor(["administer"]), actor, "No key.", { tool: "api_key_create" })).toEqual({ detail: "No key.", nextTool: "api_key_create" });
  });
});
