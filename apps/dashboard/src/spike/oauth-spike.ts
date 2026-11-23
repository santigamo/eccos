/**
 * SPIKE (openspec/changes/add-mcp-server task 0.3). Throwaway; never merged.
 *
 * - ConsoleRPC: a named WorkerEntrypoint exported from the TanStack Start server entry.
 * - authorize(): verifies a raw access token in process, then re-derives everything.
 * - RFC 8414 metadata at the issuer-inserted well-known path.
 * - Minimal workspace and consent pages (plain HTML; the real ones are TanStack routes).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getLocalJwksSource } from "@better-auth/oauth-provider/internal";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createAuth } from "../auth/auth";
import { authConfigFromEnv } from "../auth/config";
import { getAuthForRequest } from "../auth/request-auth";

type SpikeEnv = Parameters<typeof authConfigFromEnv>[0] & {
  DB: D1Database;
  GATEWAY: { getOrganizationAccountLink(id: string): Promise<{ accountId: string; status: string } | null> };
};

export type AuthorizeResult =
  | {
      ok: true;
      actor: {
        userId: string;
        organizationId: string;
        accountId: string;
        role: string;
        elevatedUntil: number | null;
        clientId: string;
      };
      audience: string;
      expiresAt: number;
      scope: string[];
      clientId: string;
    }
  | { ok: false; reason: "invalid_token" | "revoked" | "not_a_member" | "no_account"; detail?: string };

const WORKSPACE_CLAIM = "https://eccos.chat/workspace";

export async function authorizeToken(env: SpikeEnv, resource: string, token: string): Promise<AuthorizeResult> {
  const t0 = Date.now();
  const auth = createAuth(authConfigFromEnv(env));
  const ctx = await auth.$context;
  const local = getLocalJwksSource(ctx as never);
  if (!local) return { ok: false, reason: "invalid_token", detail: "no local jwks source" };
  let payload: Record<string, unknown>;
  try {
    payload = (await verifyJwsAccessToken(token, {
      ...local,
      verifyOptions: {
        issuer: new URL(ctx.baseURL).origin,
        audience: resource,
        typ: "at+jwt",
        requiredClaims: ["azp", "sub", "exp"],
      },
    } as never)) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: "invalid_token", detail: String(error) };
  }
  const tVerified = Date.now();
  const userId = String(payload.sub);
  const clientId = String(payload.azp);
  const organizationId = String(payload[WORKSPACE_CLAIM] ?? "");
  if (!organizationId) return { ok: false, reason: "invalid_token", detail: "no workspace claim" };

  const [consent, member] = await env.DB.batch<{ id?: string; role?: string }>([
    env.DB.prepare('SELECT id FROM oauthConsent WHERE userId = ? AND clientId = ? AND referenceId = ?').bind(
      userId,
      clientId,
      organizationId,
    ),
    env.DB.prepare('SELECT role FROM member WHERE userId = ? AND organizationId = ?').bind(userId, organizationId),
  ]);
  if (!consent.results[0]) return { ok: false, reason: "revoked" };
  const role = member.results[0]?.role;
  if (!role) return { ok: false, reason: "not_a_member" };
  let link: { accountId: string; status: string } | null = null;
  try {
    link = await env.GATEWAY.getOrganizationAccountLink(organizationId);
  } catch (error) {
    return { ok: false, reason: "no_account", detail: "gateway: " + String(error) };
  }
  if (!link || link.status !== "active") return { ok: false, reason: "no_account", detail: JSON.stringify(link) };
  console.info(
    "SPIKE_AUTHORIZE " + JSON.stringify({ verifyMs: tVerified - t0, totalMs: Date.now() - t0, userId, organizationId, role }),
  );
  return {
    ok: true,
    actor: { userId, organizationId, accountId: link.accountId, role, elevatedUntil: null, clientId },
    audience: resource,
    expiresAt: Number(payload.exp),
    scope: String(payload.scope ?? "").split(" ").filter(Boolean),
    clientId,
  };
}

/** Same check through public API only: auth.api.getJwks() in process + jose. */
export async function verifyWithPublicApi(env: SpikeEnv, resource: string, token: string) {
  const t0 = Date.now();
  const auth = createAuth(authConfigFromEnv(env));
  const ctx = await auth.$context;
  const jwks = (await (auth.api as unknown as { getJwks(): Promise<{ keys: unknown[] }> }).getJwks()) as never;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: new URL(ctx.baseURL).origin,
      audience: resource,
      typ: "at+jwt",
      requiredClaims: ["azp", "sub", "exp"],
    });
    return { ok: true, ms: Date.now() - t0, sub: payload.sub, typ: protectedHeader.typ };
  } catch (error) {
    return { ok: false, ms: Date.now() - t0, error: String(error) };
  }
}

/** The named entrypoint: does the TanStack Start build keep it? */
export class ConsoleRPC extends WorkerEntrypoint<SpikeEnv> {
  ping(): string {
    return "console-rpc-ok";
  }
  async compareVerify(resource: string, token: string) {
    const internal = await authorizeToken(this.env, resource, token);
    const publicApi = await verifyWithPublicApi(this.env, resource, token);
    return { internalOk: internal.ok, internalReason: internal.ok ? null : internal.reason, publicApi };
  }
  authorize(resource: string, token: string): Promise<AuthorizeResult> {
    return authorizeToken(this.env, resource, token);
  }
  async elevationOf(actor: { userId: string; clientId: string; organizationId: string }): Promise<number | null> {
    await ensureElevationTable(this.env.DB);
    const row = await this.env.DB.prepare(
      "SELECT elevatedUntil FROM spike_elevation WHERE userId = ? AND clientId = ? AND organizationId = ? AND elevatedUntil IS NOT NULL ORDER BY elevatedUntil DESC",
    )
      .bind(actor.userId, actor.clientId, actor.organizationId)
      .first<{ elevatedUntil: number }>();
    return row?.elevatedUntil ?? null;
  }
  async requestElevation(
    actor: { userId: string; clientId: string; organizationId: string },
    tool: string,
  ): Promise<{ url: string; requestId: string; expiresAt: number }> {
    await ensureElevationTable(this.env.DB);
    const base = this.env.BETTER_AUTH_URL?.trim() || "http://localhost:3000";
    const pending = await this.env.DB.prepare(
      "SELECT id, expiresAt FROM spike_elevation WHERE userId = ? AND clientId = ? AND organizationId = ? AND elevatedUntil IS NULL AND expiresAt > ?",
    )
      .bind(actor.userId, actor.clientId, actor.organizationId, Date.now())
      .first<{ id: string; expiresAt: number }>();
    if (pending) return { url: `${base}/spike/approve?request=${pending.id}`, requestId: pending.id, expiresAt: pending.expiresAt };
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + 10 * 60_000;
    await this.env.DB.prepare(
      "INSERT INTO spike_elevation (id, userId, clientId, organizationId, tool, expiresAt) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, actor.userId, actor.clientId, actor.organizationId, tool, expiresAt)
      .run();
    return { url: `${base}/spike/approve?request=${id}`, requestId: id, expiresAt };
  }
}

async function ensureElevationTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS spike_elevation (id TEXT PRIMARY KEY, userId TEXT NOT NULL, clientId TEXT NOT NULL, organizationId TEXT NOT NULL, tool TEXT, expiresAt INTEGER NOT NULL, elevatedUntil INTEGER)",
    )
    .run();
}

const html = (body: string): Response =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Eccos spike</title><body style="font-family:system-ui;max-width:40rem;margin:3rem auto">${body}</body>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** Before the page gate: public metadata. */
export function spikePublic(request: Request, pathname: string, env: SpikeEnv): Promise<Response> | undefined {
  if (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/oauth-authorization-server/api/auth") {
    const auth = getAuthForRequest(request, env);
    return oauthProviderAuthServerMetadata(auth as never)(request);
  }
  return undefined;
}

/** After the page gate (a session exists): the workspace and consent pages. */
export async function spikePages(request: Request, pathname: string, env: SpikeEnv): Promise<Response | undefined> {
  if (pathname === "/spike/workspace") {
    const auth = getAuthForRequest(request, env);
    const orgs = (await auth.api.listOrganizations({ headers: request.headers })) as Array<{ id: string; name: string }>;
    const rows = orgs.map((o) => `<li><button data-org="${esc(o.id)}">${esc(o.name)}</button> <code>${esc(o.id)}</code></li>`).join("");
    return html(`<h1>Choose the workspace this agent will work in</h1><ul id="orgs">${rows || "<li>No workspace yet (the real page is the onboarding form)</li>"}</ul>
<script>
const q = location.search.slice(1);
document.querySelectorAll("button[data-org]").forEach((b) => b.onclick = async () => {
  await fetch("/api/auth/organization/set-active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: b.dataset.org }) });
  const r = await fetch("/api/auth/oauth2/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postLogin: true, oauth_query: q }) });
  const j = await r.json();
  location.href = j.url ?? j.redirect_uri ?? j.uri;
});
</script>`);
  }
  if (pathname === "/spike/create-workspace" && request.method === "POST") {
    // Same two calls as the createOrganization server function (src/organizations.ts).
    const auth = getAuthForRequest(request, env);
    const { name } = (await request.json()) as { name: string };
    const org = (await auth.api.createOrganization({ body: { name, slug: crypto.randomUUID() }, headers: request.headers })) as { id: string };
    const link = await (env.GATEWAY as unknown as { ensureOrganizationAccount(id: string, name: string): Promise<{ accountId: string }> }).ensureOrganizationAccount(org.id, name);
    return Response.json({ organizationId: org.id, accountId: link.accountId });
  }
  if (pathname === "/spike/approve") {
    const auth = getAuthForRequest(request, env);
    const session = await auth.api.getSession({ headers: request.headers });
    const id = new URL(request.url).searchParams.get("request") ?? "";
    await ensureElevationTable(env.DB);
    const row = await env.DB.prepare("SELECT * FROM spike_elevation WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!session || !row || row.userId !== session.user.id || Number(row.expiresAt) < Date.now()) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method === "POST") {
      // The real page requires TOTP and a fresh sign-in (PR #78); the spike only proves the round trip.
      await env.DB.prepare("UPDATE spike_elevation SET elevatedUntil = ? WHERE id = ?").bind(Date.now() + 24 * 3600_000, id).run();
      return html("<h1 id='done'>Approved for 24 hours</h1><p>Return to your agent.</p>");
    }
    return html(`<h1>Approve sensitive actions</h1><p>Agent <code>${esc(row.clientId)}</code> asked to run <b>${esc(row.tool)}</b>.</p><form method="post"><button id="approve">Approve for 24 hours</button></form>`);
  }
  if (pathname === "/spike/consent") {
    const auth = getAuthForRequest(request, env);
    const params = new URL(request.url).searchParams;
    let client: Record<string, unknown> = {};
    try {
      client = (await auth.api.getOAuthClientPublic({ query: { client_id: params.get("client_id") ?? "" }, headers: request.headers })) as Record<string, unknown>;
    } catch (error) {
      client = { error: String(error) };
    }
    const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
    return html(`<h1>Allow this agent to work in your workspace?</h1>
<p>Client says it is: <b id="client">${esc(client.client_name ?? client.name)}</b></p>
<p>client_id: <code>${esc(params.get("client_id"))}</code></p>
<p>Raw client: <code>${esc(JSON.stringify(client))}</code></p>
<form id="f">${scopes.map((s) => `<label><input type="checkbox" name="scope" value="${esc(s)}" checked> ${esc(s)}</label><br>`).join("")}
<button id="approve">Approve</button> <button id="deny" type="button">Deny</button></form>
<script>
const q = location.search.slice(1);
const send = async (accept) => {
  const scope = [...document.querySelectorAll("input[name=scope]:checked")].map((i) => i.value).join(" ");
  const r = await fetch("/api/auth/oauth2/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept, scope, oauth_query: q }) });
  const j = await r.json();
  location.href = j.url ?? j.redirect_uri ?? j.uri;
};
document.getElementById("f").onsubmit = (e) => { e.preventDefault(); send(true); };
document.getElementById("deny").onclick = () => send(false);
</script>`);
  }
  return undefined;
}
