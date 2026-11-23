import { describe, expect, test } from "bun:test";
import { GATEWAY_ACTIONS, roles } from "@eccos/auth-baseline/permissions";
import { AGENT_SCOPES, type AgentAction, type AuthorizeResult, type MemberRole } from "../src/index";

describe("console contract vocabulary", () => {
  test("every agent action is granted by exactly one scope", () => {
    const expected: AgentAction[] = [...GATEWAY_ACTIONS.filter((action) => action !== "erase"), "send"];
    expect(Object.values(AGENT_SCOPES).sort()).toEqual([...expected].sort());
  });

  test("no scope grants erasure", () => {
    expect(Object.values(AGENT_SCOPES)).not.toContain("erase");
  });

  test("the roles are the auth baseline's", () => {
    const named: MemberRole[] = ["owner", "admin", "operator", "viewer"];
    expect(Object.keys(roles).sort()).toEqual([...named].sort());
  });
});

// Type-level, checked by `bun run typecheck`: the vocabulary is exactly the intended one, and
// illegal states are rejected.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const rolesExact: Equal<MemberRole, "owner" | "admin" | "operator" | "viewer"> = true;
const actionsExact: Equal<AgentAction, "view" | "operate" | "send" | "configure" | "administer"> = true;
// @ts-expect-error erase is never an agent action
const erase: AgentAction = "erase";
// @ts-expect-error a refusal carries no actor
const refusedWithActor: AuthorizeResult = { ok: false, code: "revoked", actor: {} };
// @ts-expect-error refusals are named by code
const refusedByReason: AuthorizeResult = { ok: false, reason: "revoked" };
void [rolesExact, actionsExact, erase, refusedWithActor, refusedByReason];
