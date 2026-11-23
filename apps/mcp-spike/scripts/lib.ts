// THROWAWAY spike driver helpers (task 0.3). A "browser" with a cookie jar, and the mail log reader.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

export const CONSOLE = process.env.CONSOLE_URL ?? "http://localhost:3000";
export const MCP = process.env.MCP_URL ?? "http://localhost:8788";
export const RESOURCE = process.env.MCP_RESOURCE ?? `${MCP}/mcp`;
export const LOG = process.env.DASHBOARD_LOG ?? `${process.env.HOME}/.capy/work/spike/logs/dashboard.log`;
export const EVIDENCE = new URL("../evidence/", import.meta.url).pathname;

export class Browser {
  jar = new Map<string, string>();
  trail: string[] = [];
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (!headers.has("origin") && init.method && init.method !== "GET") headers.set("origin", CONSOLE);
    if (!headers.has("accept")) headers.set("accept", "text/html,application/json");
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/max-age=0/i.test(c) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    this.trail.push(`${init.method ?? "GET"} ${redact(url)} -> ${res.status}${res.headers.get("location") ? " Location: " + redact(res.headers.get("location")!) : ""}`);
    return res;
  }
  /** Follow redirects that stay on the console; stop at the first non-redirect or foreign location. */
  async follow(url: string, stopAt: (u: URL) => boolean = () => false): Promise<{ res: Response; url: string }> {
    let current = url;
    for (let i = 0; i < 15; i++) {
      const res = await this.fetch(current);
      let loc = res.headers.get("location");
      // Better Auth answers a fetch-style request (Accept: application/json) with { redirect, url } instead of a 302.
      if (!loc && res.status === 200 && res.headers.get("content-type")?.includes("application/json")) {
        const j = (await res.clone().json()) as { redirect?: boolean; url?: string };
        if (j.redirect && j.url) {
          loc = j.url;
          this.trail.push("  (JSON redirect) -> " + redact(j.url));
        }
      }
      if (res.status < 300 && !loc) return { res, url: current };
      if (res.status >= 400 || !loc) return { res, url: current };
      const next = new URL(loc, current);
      if (next.origin !== new URL(CONSOLE).origin || stopAt(next)) return { res, url: next.href };
      current = next.href;
    }
    throw new Error("too many redirects");
  }
  post(path: string, body: unknown): Promise<Response> {
    return this.fetch(CONSOLE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
}

/** Keep evidence readable and free of bearer values. */
export function redact(s: string): string {
  return s
    .replace(/(token|code|sig|code_challenge|state|refresh_token|access_token)=([^&\s"]{12})[^&\s"]*/g, "$1=$2…")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>");
}

export function mailUrl(to: string, template = "verify-email"): string {
  const lines = readFileSync(LOG, "utf8").split("\n").filter((l) => l.includes("SPIKE_MAIL_URL"));
  for (const line of lines.reverse()) {
    const j = JSON.parse(line.slice(line.indexOf("{")));
    if (j.to === to && j.template === template) return j.url;
  }
  throw new Error("no mail for " + to);
}

export const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function save(name: string, data: unknown): void {
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(EVIDENCE + name, typeof data === "string" ? data : redact(JSON.stringify(data, null, 2)) + "\n");
  console.log("evidence -> evidence/" + name);
}

export const PASSWORD = "spike-password-12345";

/** Sign up, follow the verification link (auto sign-in), optionally create a workspace. */
export async function newUser(tag: string, workspace?: string): Promise<{ b: Browser; email: string; organizationId?: string }> {
  const b = new Browser();
  const email = `${tag}-${Date.now()}@spike.test`;
  const r = await b.post("/api/auth/sign-up/email", { email, password: PASSWORD, name: tag, callbackURL: "/" });
  if (!r.ok) throw new Error("sign-up failed " + r.status + " " + (await r.text()));
  await sleep(500);
  await b.follow(mailUrl(email));
  let organizationId: string | undefined;
  if (workspace) {
    const w = await b.post("/spike/create-workspace", { name: workspace });
    if (!w.ok) throw new Error("workspace failed " + w.status + " " + (await w.text()));
    organizationId = ((await w.json()) as { organizationId: string }).organizationId;
  }
  return { b, email, organizationId };
}

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split(".");
  const d = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());
  return { header: d(h), payload: d(p) };
}
