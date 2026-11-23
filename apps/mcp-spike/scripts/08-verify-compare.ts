// Bullet: verifying a raw access token in process. Internal helper vs public API only.
import { MCP, save } from "./lib";
const s = await Bun.file(new URL("../evidence/.session.json", import.meta.url).pathname).json();
const t = s.tokens.access_token as string;
const cmp = async (label: string, token: string, resource?: string) => ({ label, ...(await (await fetch(MCP + "/spike/compare-verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, resource }) })).json()) });
const out = [
  await cmp("valid access token", t),
  await cmp("wrong audience", t, "https://other.example/mcp"),
  await cmp("tampered", t.slice(0, -4) + "AAAA"),
  await cmp("refresh token", s.tokens.refresh_token),
];
save("08-verify-compare.json", out);
console.log(JSON.stringify(out, null, 1));
