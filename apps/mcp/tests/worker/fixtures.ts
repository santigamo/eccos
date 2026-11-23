import { z } from "zod";
import { createApp } from "../../src/app";
import { TOOLS } from "../../src/tools";
import { ToolError, defineTool } from "../../src/tools/registry";

/** A step-up, mutating tool that never ships: it exercises the guard and the audit line. */
export const rotateSecret = defineTool({
  name: "fixture_secret_rotate",
  action: "administer",
  stepUp: true,
  title: "Rotate a secret (test fixture)",
  description: "Test fixture for a step-up tool.",
  inputSchema: z.object({ wabaId: z.string(), secretValue: z.string() }),
  outputSchema: z.object({ status: z.literal("rotated"), wabaId: z.string() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  audit: (input) => ({ wabaId: input.wabaId }),
  run: async (input) => ({ status: "rotated" as const, wabaId: input.wabaId }),
});

/** A configure-scope mutating tool that can be told to fail. */
export const configureThing = defineTool({
  name: "fixture_configure",
  action: "configure",
  stepUp: false,
  title: "Configure a thing (test fixture)",
  description: "Test fixture for a mutating tool.",
  inputSchema: z.object({ wabaId: z.string(), fail: z.boolean().default(false) }),
  outputSchema: z.object({ status: z.literal("configured"), wabaId: z.string() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  audit: (input) => ({ wabaId: input.wabaId }),
  run: async (input) => {
    if (input.fail) throw new ToolError("The fixture was told to fail. Call fixture_configure again with fail: false.");
    return { status: "configured" as const, wabaId: input.wabaId };
  },
});

export const fixtureApp = createApp([...TOOLS, rotateSecret, configureThing]);
