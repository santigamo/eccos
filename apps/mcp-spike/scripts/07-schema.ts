// How a tool result with isError and structuredContent is carried, with and without an outputSchema.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP, save } from "./lib";

const s = await Bun.file(new URL("../evidence/.session.json", import.meta.url).pathname).json();
const out: Record<string, unknown> = {};
for (const mode of [{ pin: "2026-07-28" }, "legacy"] as const) {
  const client = new Client({ name: "spike-schema", version: "0" }, { capabilities: {}, versionNegotiation: { mode } } as never);
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP + "/mcp"), { authProvider: { token: async () => s.tokens.access_token } } as never));
  const tools = (await client.listTools()).tools.filter((t) => t.name.endsWith("_stepup")).map((t) => ({ name: t.name, outputSchemaType: (t.outputSchema as { type?: string; anyOf?: unknown[] })?.type ?? Object.keys(t.outputSchema ?? {}) }));
  const results: Record<string, unknown> = {};
  for (const name of ["strict_stepup", "union_stepup"]) {
    try { results[name] = await client.callTool({ name, arguments: {} }); } catch (e) { results[name] = { thrown: String(e) }; }
  }
  out[typeof mode === "string" ? mode : mode.pin] = { tools, results };
  await client.close();
}
save("07-schema.json", out);
console.log(JSON.stringify(out, null, 1).slice(0, 5000));
