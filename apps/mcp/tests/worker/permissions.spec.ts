import type { AgentAction, MemberRole } from "@eccos/console-contract";
import { AGENT_SCOPES } from "@eccos/console-contract";
import { roles } from "@eccos/auth-baseline/permissions";
import { describe, expect, it } from "vitest";
import { LEAST_ROLE, SCOPE_OF, forbiddenMessage } from "../../src/permissions";
import { type Clients, ForbiddenError, ToolError, capabilities } from "../../src/tools/registry";

const clients = { gateway: {}, console: {} } as unknown as Clients;

describe("capabilities", () => {
  it("hands out the clients for an action the actor holds", () => {
    const deps = capabilities({ actions: ["view"] }, clients, "https://console.example.test");

    expect(deps.can("view")).toBe(true);
    expect(deps.for("view")).toBe(clients);
  });

  it("refuses the clients for an action the actor lacks, saying what it needs and who has it", () => {
    const deps = capabilities({ actions: ["view", "operate"] }, clients, "https://console.example.test");

    expect(deps.can("administer")).toBe(false);
    expect(() => deps.for("administer")).toThrow(ForbiddenError);
    expect(() => deps.for("administer")).toThrow(
      "This connection cannot administer: that needs the eccos:administer scope, granted by a person who is an admin or above in this workspace. Ask such a person to connect the agent with that scope, or to do this in the Eccos console.",
    );
    try {
      deps.for("send");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ForbiddenError).action).toBe("send");
    }
  });

  it("names an operator as the least role for operate", () => {
    expect(forbiddenMessage("operate")).toContain("the eccos:operate scope, granted by a person who is an operator or above");
  });

  it("names a viewer with the right article", () => {
    expect(forbiddenMessage("view")).toContain("the eccos:view scope, granted by a person who is a viewer or above");
  });
});

describe("permissions table", () => {
  it("maps each action to the scope that grants it", () => {
    for (const [scope, action] of Object.entries(AGENT_SCOPES)) expect(SCOPE_OF[action as AgentAction]).toBe(scope);
  });

  it("matches the role matrix in @eccos/auth-baseline (send is operator+, contract § 4)", () => {
    const order: MemberRole[] = ["viewer", "operator", "admin", "owner"];
    const least = (action: string) =>
      order.find((role) => (roles[role].statements.gateway as readonly string[] | undefined)?.includes(action));

    expect(LEAST_ROLE).toEqual({
      view: least("view"),
      operate: least("operate"),
      send: least("operate"),
      configure: least("configure"),
      administer: least("administer"),
    });
  });
});
