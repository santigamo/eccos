import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, gatewayStub, consoleStub, grantToken, makeActor, postMcp, resetStubs, toolsList } from "./helpers";

beforeEach(resetStubs);
afterEach(() => {
  vi.restoreAllMocks();
});

function captureErrors(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

describe("failure logs", () => {
  it("logs a failing authorize as one line without the token, and still answers 503", async () => {
    const token = await grantToken(makeActor());
    await consoleStub.failAuthorize(`upstream rejected ${token}`);
    const lines = captureErrors();
    const response = await postMcp(toolsList(), { token });

    expect(response.status).toBe(503);
    const ours = lines.filter((line) => line.includes('"area":"mcp"'));
    expect(ours.map((line) => JSON.parse(line))).toEqual([
      { level: "error", area: "mcp", event: "authorize_failure", tool: null, error: "Error" },
    ]);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("logs a failing gateway call as one line without the message, and answers the generic error", async () => {
    const token = await grantToken(makeActor());
    await gatewayStub.fail("listAccountResources", `gateway leaked ${token}`);
    const lines = captureErrors();
    const client = await connect(token);
    const result = await client.callTool({ name: "workspace_get", arguments: {} });
    await client.close();

    expect(result).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: "Eccos could not complete workspace_get. Try again in a minute; if it keeps failing, tell the person." },
      ],
    });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { level: "error", area: "mcp", event: "tool_failure", tool: "workspace_get", error: "Error" },
    ]);
    expect(lines.join("\n")).not.toContain(token);
  });
});
