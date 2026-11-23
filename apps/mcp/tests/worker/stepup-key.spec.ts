import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureApp } from "./fixtures";
import { connect, grantToken, makeActor, resetStubs } from "./helpers";

// Its own file: the key is checked once per isolate, so no other spec may have built a server
// with a short key first.

beforeEach(resetStubs);
afterEach(() => {
  vi.restoreAllMocks();
});

const SHORT = "only-31-bytes-long-0123456789ab";
const shortKey = { ...env, REQUEST_STATE_KEY: SHORT };

describe("a REQUEST_STATE_KEY shorter than 32 bytes", () => {
  it("is treated as unset: no URL elicitation, the structured result, one error line per isolate", async () => {
    expect(new TextEncoder().encode(SHORT).byteLength).toBe(31);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let prompts = 0;
    const call = async () => {
      const client = await connect(await grantToken(makeActor()), {
        target: fixtureApp,
        bindings: shortKey,
        capabilities: { elicitation: { url: {} } },
        onElicit: async () => {
          prompts += 1;
          return { action: "accept" };
        },
      });
      const result = await client.callTool({ name: "fixture_secret_rotate", arguments: { wabaId: "waba-1", secretValue: "s" } });
      await client.close();
      return result;
    };

    const first = await call();
    const second = await call();

    expect(prompts).toBe(0);
    expect(first.structuredContent).toMatchObject({ status: "approval_required" });
    expect(second.structuredContent).toMatchObject({ status: "approval_required" });
    expect(errors.map((line) => JSON.parse(line))).toEqual([
      {
        level: "error",
        area: "mcp",
        event: "request_state_key_too_short",
        detail: "REQUEST_STATE_KEY must be at least 32 bytes; URL elicitation is off until it is.",
      },
    ]);
    expect(errors.join("\n")).not.toContain(SHORT);
  });
});
