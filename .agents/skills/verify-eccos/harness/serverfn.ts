// Calls one console server function over HTTP the way the browser does, without the UI
// (see ../SKILL.md, "Drive"). Usage, run by verify-eccos serverfn:
//   bun serverfn.ts <dashboard-origin> <cookie-jar> <src file> <export> [json data]
// <src file> is relative to apps/dashboard, such as src/server/gateway.ts.
// Prints the HTTP status and the decoded result.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const [origin, jar, file, name, json] = process.argv.slice(2);
if (!origin || !jar || !file || !name) throw new Error("usage: serverfn.ts <origin> <cookie-jar> <src file> <export> [json]");

const dashboard = join(dirname(new URL(import.meta.url).pathname), "../../../../apps/dashboard");
const start = realpathSync(join(dashboard, "node_modules/@tanstack/react-start/package.json"));
const { toJSONAsync, fromJSON } = await import(Bun.resolveSync("seroval", dirname(start)));

const cookie = readFileSync(jar, "utf8")
  .split("\n")
  .map((line) => line.replace(/^#HttpOnly_/, "").split("\t"))
  .filter((cols) => cols.length === 7)
  .map((cols) => `${cols[5]}=${cols[6]}`)
  .join("; ");

const id = Buffer.from(JSON.stringify({ file: `/${file}?tss-serverfn-split`, export: `${name}_createServerFn_handler` })).toString(
  "base64url",
);
const payload = JSON.stringify(await toJSONAsync({ data: json === undefined ? undefined : JSON.parse(json), context: {} }));
const headers = { "x-tsr-serverfn": "true", origin, cookie };
// A GET server function answers 405 to a POST; it takes the payload in the query instead.
let response = await fetch(`${origin}/_serverFn/${id}`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: payload,
});
if (response.status === 405) {
  response = await fetch(`${origin}/_serverFn/${id}?payload=${encodeURIComponent(payload)}`, { headers });
}
const text = await response.text();
let result: unknown = text;
try {
  const decoded = fromJSON({ t: JSON.parse(text), f: 0, m: [] }) as { result?: unknown; error?: unknown };
  result = decoded.error ?? decoded.result;
} catch {}
console.log(`HTTP ${response.status}`);
console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
