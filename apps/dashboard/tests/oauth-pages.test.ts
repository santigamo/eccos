/**
 * The workspace step and the consent page of the console's OAuth authorization
 * server (openspec/changes/add-mcp-server task 1.3, design §3.1, §3.5; spec
 * "A grant is bound to one workspace"). Driven the way the two pages drive it:
 * the console's own server functions for the workspace, then Better Auth's
 * `oauth2/continue` and `oauth2/consent` with the signed query, against a real
 * sqlite schema. Every assertion is an HTTP outcome or a token claim.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { withD1Statements } from "./helpers/d1-statements";

const BASE_URL = "http://localhost:3000";
const SECRET = "test-secret-32-chars-minimum-length!!";
const REDIRECT_URI = "https://agent.example.com/callback";
const PASSWORD = "correct-horse-battery";
const REQUESTED = "eccos:view eccos:send eccos:administer offline_access";

/** The bindings the server functions read. Mutated, never reassigned (see onboarding.test.ts). */
const fakeEnv: Record<string, unknown> = {};
let fakeRequestHeaders = new Headers();
installServerFnMocks({
  env: fakeEnv,
  getRequest: () => new Request(`${BASE_URL}/oauth/workspace`, { headers: fakeRequestHeaders }),
});

const { createOrganization, selectOrganization } = await import("../src/organizations");
const { createAuth } = await import("../src/auth/auth");
const { authConfigFromEnv } = await import("../src/auth/config");
const { WORKSPACE_CLAIM } = await import("../src/auth/oauth-provider");

/** Every gateway call the flow makes, by method name. */
let gatewayCalls: string[] = [];
let resources = 0;

async function testAuth() {
  for (const key of Object.keys(fakeEnv)) delete fakeEnv[key];
  const db = withD1Statements(new Database(":memory:"));
  const resource = `http://localhost:8788/mcp/pages-${++resources}`;
  Object.assign(fakeEnv, {
    BETTER_AUTH_URL: BASE_URL,
    BETTER_AUTH_SECRET: SECRET,
    MCP_RESOURCE: resource,
    DB: db,
    GATEWAY: new Proxy(
      {},
      {
        get: (_target, method: string) => async (organizationId: string) => {
          gatewayCalls.push(method);
          if (method === "ensureOrganizationAccount") return { accountId: `acct-${organizationId}`, status: "active" };
          return null;
        },
      },
    ),
  });
  const auth = createAuth(authConfigFromEnv(fakeEnv as never));
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return { auth, db, resource };
}

afterEach(() => {
  fakeRequestHeaders = new Headers();
  gatewayCalls = [];
});

type Auth = Awaited<ReturnType<typeof testAuth>>["auth"];

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

function post(auth: Auth, path: string, body: unknown, cookie?: string): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The signed query a page passes back, as oauthProviderClient sends it. */
function oauthQueryOf(url: string): string {
  return new URL(url, BASE_URL).search.slice(1);
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** An agent registers by DCR and opens the authorize URL; the person signs up and signs in. */
async function signedInAtWorkspaceStep(auth: Auth, db: Database, resource: string, email: string) {
  const registered = await auth.handler(
    new Request(`${BASE_URL}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Agent",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  const clientId = (await json<{ client_id: string }>(registered)).client_id;
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const authorize = await auth.handler(
    new Request(
      `${BASE_URL}/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: REQUESTED,
        resource,
        state: "state-1",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    ),
  );
  const signInPage = authorize.headers.get("location")!;
  await post(auth, "/sign-up/email", { email, password: PASSWORD, name: email });
  db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
  const signIn = await post(auth, "/sign-in/email", { email, password: PASSWORD, oauth_query: oauthQueryOf(signInPage) });
  const cookie = cookiesOf(signIn);
  const workspaceStep = (await json<{ url: string }>(signIn)).url;
  fakeRequestHeaders = new Headers({ cookie, origin: BASE_URL });
  return { clientId, verifier, cookie, workspaceStep, resource };
}

/** A workspace created in process, as a second account owns it. */
async function workspaceOf(auth: Auth, db: Database, email: string, name: string): Promise<string> {
  await post(auth, "/sign-up/email", { email, password: PASSWORD, name: email });
  db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
  const cookie = cookiesOf(await post(auth, "/sign-in/email", { email, password: PASSWORD }));
  const org = await auth.api.createOrganization({
    body: { name, slug: crypto.randomUUID() },
    headers: new Headers({ cookie }),
  });
  return org!.id;
}

/** The workspace page's "continue": Better Auth's continuation with the signed query. */
async function continueFrom(auth: Auth, page: string, cookie: string) {
  const response = await post(auth, "/oauth2/continue", { postLogin: true, oauth_query: oauthQueryOf(page) }, cookie);
  const body = await response.json().catch(() => ({})) as { url?: string };
  return { status: response.status, url: body.url };
}

async function consent(auth: Auth, consentPage: string, cookie: string, decision: { accept: boolean; scope?: string }) {
  const response = await post(auth, "/oauth2/consent", { ...decision, oauth_query: oauthQueryOf(consentPage) }, cookie);
  return new URL((await json<{ url: string }>(response)).url);
}

async function tokenFor(auth: Auth, flow: { clientId: string; verifier: string; resource: string }, callback: URL) {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        code_verifier: flow.verifier,
        client_id: flow.clientId,
        redirect_uri: REDIRECT_URI,
        resource: flow.resource,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const { access_token } = await json<{ access_token: string }>(response);
  const payload = access_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload)) as Record<string, unknown>;
}

function pathOf(url: string | undefined): string | undefined {
  return url ? new URL(url, BASE_URL).pathname : undefined;
}

describe("the workspace step", () => {
  test("a user with two workspaces must pick one, and the token names the one picked", async () => {
    const { auth, db, resource } = await testAuth();
    const flow = await signedInAtWorkspaceStep(auth, db, resource, "owner@corp.test");
    const first = await createOrganization({ data: { name: "First" } });
    const second = await createOrganization({ data: { name: "Second" } });
    if (!first.ok || !second.ok) throw new Error("workspaces not created");

    const reauthorized = await auth.handler(
      new Request(new URL(`/api/auth/oauth2/authorize?${oauthQueryOf(flow.workspaceStep)}`, BASE_URL), {
        headers: { cookie: flow.cookie },
      }),
    );
    expect(pathOf(reauthorized.headers.get("location") ?? undefined)).toBe("/oauth/workspace");

    expect(await selectOrganization({ data: { organizationId: first.data.organizationId } })).toEqual({ ok: true });
    const continued = await continueFrom(auth, flow.workspaceStep, flow.cookie);
    expect(pathOf(continued.url)).toBe("/oauth/consent");
    const callback = await consent(auth, continued.url!, flow.cookie, { accept: true });
    const claims = await tokenFor(auth, flow, callback);
    expect(claims[WORKSPACE_CLAIM]).toBe(first.data.organizationId);
  });

  test("picking a workspace the user does not belong to cannot bind it", async () => {
    const { auth, db, resource } = await testAuth();
    const flow = await signedInAtWorkspaceStep(auth, db, resource, "owner@corp.test");
    const foreign = await workspaceOf(auth, db, "stranger@corp.test", "Theirs");

    const picked = await selectOrganization({ data: { organizationId: foreign } });
    expect(picked.ok).toBe(false);
    const forged = await post(auth, "/organization/set-active", { organizationId: foreign }, flow.cookie);
    expect(forged.status).toBeGreaterThanOrEqual(400);

    const continued = await continueFrom(auth, flow.workspaceStep, flow.cookie);
    expect(pathOf(continued.url)).not.toBe("/oauth/consent");
  });

  test("a workspace the user has since left cannot be bound by the continuation", async () => {
    const { auth, db, resource } = await testAuth();
    const flow = await signedInAtWorkspaceStep(auth, db, resource, "owner@corp.test");
    const left = await createOrganization({ data: { name: "Left" } });
    if (!left.ok) throw new Error("workspace not created");
    db.query('DELETE FROM member WHERE "organizationId" = ?').run(left.data.organizationId);

    const continued = await continueFrom(auth, flow.workspaceStep, flow.cookie);
    expect(pathOf(continued.url)).toBe("/oauth/workspace");
  });

  test("a user with no workspace names one: its account is provisioned, no API key, and the flow reaches consent", async () => {
    const { auth, db, resource } = await testAuth();
    const flow = await signedInAtWorkspaceStep(auth, db, resource, "new@corp.test");
    expect(pathOf(flow.workspaceStep)).toBe("/oauth/workspace");
    const stuck = await continueFrom(auth, flow.workspaceStep, flow.cookie);
    expect(pathOf(stuck.url)).not.toBe("/oauth/consent");

    const created = await createOrganization({ data: { name: "Shop" } });
    expect(created).toEqual({
      ok: true,
      data: { organizationId: expect.any(String), accountId: expect.stringMatching(/^acct-/) },
    });
    expect(gatewayCalls).toContain("ensureOrganizationAccount");
    expect(gatewayCalls).not.toContain("issueApiKey");

    const continued = await continueFrom(auth, flow.workspaceStep, flow.cookie);
    expect(pathOf(continued.url)).toBe("/oauth/consent");
    const callback = await consent(auth, continued.url!, flow.cookie, { accept: true });
    const claims = await tokenFor(auth, flow, callback);
    expect(claims[WORKSPACE_CLAIM]).toBe(created.ok ? created.data.organizationId : "");
  });
});

describe("the consent page", () => {
  async function atConsent() {
    const { auth, db, resource } = await testAuth();
    const flow = await signedInAtWorkspaceStep(auth, db, resource, "owner@corp.test");
    await createOrganization({ data: { name: "Shop" } });
    const continued = await continueFrom(auth, flow.workspaceStep, flow.cookie);
    return { auth, flow, consentPage: continued.url! };
  }

  test("unticked scopes are absent from the token", async () => {
    const { auth, flow, consentPage } = await atConsent();
    const callback = await consent(auth, consentPage, flow.cookie, { accept: true, scope: "eccos:view offline_access" });
    const claims = await tokenFor(auth, flow, callback);
    expect(String(claims.scope).split(" ").sort()).toEqual(["eccos:view", "offline_access"]);
  });

  test("deny returns access_denied to the client's redirect URI", async () => {
    const { auth, flow, consentPage } = await atConsent();
    const callback = await consent(auth, consentPage, flow.cookie, { accept: false });
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("state-1");
    expect(callback.searchParams.get("code")).toBeNull();
  });
});
