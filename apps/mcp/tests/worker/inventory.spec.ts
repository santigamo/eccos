import { beforeEach, describe, expect, it } from "vitest";
import { connect, grantToken, makeActor, resetStubs } from "./helpers";

beforeEach(resetStubs);

const SETUP_TOOLS = {
  api_key_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  api_key_revoke: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  api_keys_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  billing_checkout_link: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  billing_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  connect_link_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  connect_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  number_recheck: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  numbers_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  status_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  template_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  template_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  template_edit: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  template_send_test: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  templates_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  webhook_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  webhook_resubscribe: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  webhook_set: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  workspace_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

describe("tool inventory", () => {
  it("lists every phase 1 setup tool for an owner, with honest annotations", async () => {
    const client = await connect(await grantToken(makeActor()));
    const { tools } = await client.listTools();
    await client.close();

    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]).sort())).toEqual(SETUP_TOOLS);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(120);
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("takes no account or organization id in any input", async () => {
    const client = await connect(await grantToken(makeActor()));
    const { tools } = await client.listTools();
    await client.close();

    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {}).filter((key) => /account|organi[sz]ation|org|tenant/i.test(key))).toEqual([]);
    }
  });

  it("puts exactly the design § 3.3 step-up tools behind elevation", async () => {
    const client = await connect(await grantToken(makeActor()));
    const { tools } = await client.listTools();
    await client.close();

    const approvalShaped = tools.filter((tool) => JSON.stringify(tool.outputSchema).includes("approval_required")).map((tool) => tool.name);
    expect(approvalShaped.sort()).toEqual(["api_key_create", "api_key_revoke", "connect_link_create", "webhook_resubscribe", "webhook_set"]);
  });

  it("lists only the view tools for a viewer whose token carries every scope", async () => {
    const client = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] })));
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    await client.close();

    expect(names).toEqual(["numbers_list", "status_get", "templates_list", "workspace_get"]);
  });
});
