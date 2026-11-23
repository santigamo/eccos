/**
 * The console as the OAuth 2.1 authorization server for the MCP resource
 * (contract §6 and §9 "OAuth authorization server endpoints", design §2.1,
 * §3.1, §3.4, §3.5). Driven through the in-process handler and the server
 * entry's own routing helpers, against a real sqlite schema.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth, type Auth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";
import {
  BLOCKED_AUTH_ENDPOINTS,
  BLOCKED_AUTH_PREFIXES,
  blockedAuthEndpointResponse,
  isBlockedAuthEndpoint,
} from "../src/auth/blocked-endpoints";
import { CIMD_USER_AGENT, cimdFetch, WORKSPACE_CLAIM } from "../src/auth/oauth-provider";
import { pendingAuthorizationURL, withPendingAuthorization } from "../src/auth/pending-authorization";
import { deleteUnusedOAuthClients } from "../src/auth/oauth-client-cleanup";
import { oauthCrossOriginApi } from "../src/server/oauth-cross-origin";
import { OAUTH_BODY_LIMIT, oauthRequestWithinLimits } from "../src/server/oauth-request-limits";

const BASE_URL = "http://localhost:3000";
/**
 * A fresh resource per database. The provider seeds its resource row once per
 * PROCESS (`resourceSeedScope: "process"`, oauth-provider.ts), which is right for
 * a Worker with one D1, while every test here brings a new in-memory database.
 */
let RESOURCE = "http://localhost:8788/mcp";
let databases = 0;
const CLIENT_ORIGIN = "https://agent.example.com";
const REDIRECT_URI = `${CLIENT_ORIGIN}/callback`;
const PASSWORD = "correct-horse-battery";

async function testAuth() {
  const db = new Database(":memory:");
  RESOURCE = `http://localhost:8788/mcp/${++databases}`;
  const mail = new CaptureMailSender();
  const auth = createAuth({
    database: db,
    secret: "test-secret-32-chars-minimum-length!!",
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mcpResource: RESOURCE,
    mail,
  });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return { auth, db, mail };
}

/** What src/server.ts does with a request, up to the page gate. */
async function serve(auth: Auth, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (isBlockedAuthEndpoint(pathname)) return blockedAuthEndpointResponse();
  const crossOrigin = oauthCrossOriginApi(request, pathname, () => auth);
  if (crossOrigin) return crossOrigin;
  if (pathname.startsWith("/api/auth/")) {
    const limited = await oauthRequestWithinLimits(request, pathname);
    return limited instanceof Response ? limited : auth.handler(limited);
  }
  return new Response("page gate", { status: 302, headers: { location: "/signin" } });
}

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

function post(auth: Auth, path: string, body: unknown, cookie?: string): Promise<Response> {
  return serve(
    auth,
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

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** Dynamic client registration from the agent's own origin, as Cursor does. */
async function registerClient(auth: Auth): Promise<string> {
  const response = await serve(
    auth,
    new Request(`${BASE_URL}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: CLIENT_ORIGIN },
      body: JSON.stringify({
        client_name: "Agent",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

const CIMD_CLIENT_ID = `${CLIENT_ORIGIN}/client.json`;

/** Serves Client ID Metadata Documents from a fake origin until the returned restore is called. */
function serveMetadataDocuments(document: (url: string) => Record<string, unknown> = () => ({})) {
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    return Response.json({
      client_id: url,
      client_name: "Agent",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...document(url),
    });
  }) as unknown as typeof fetch;
  return {
    fetched,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/** GET authorize without a session: where it sends the browser, and the PKCE verifier. */
async function startAuthorization(auth: Auth, clientId: string) {
  const { verifier, challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "eccos:view offline_access",
    resource: RESOURCE,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const response = await serve(auth, new Request(`${BASE_URL}/api/auth/oauth2/authorize?${query}`));
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!, BASE_URL);
  return { location, verifier };
}

async function signUpVerified(auth: Auth, db: Database, email: string): Promise<void> {
  await post(auth, "/sign-up/email", { email, password: PASSWORD, name: email });
  db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
}

/** The signed query a page passes back, as oauthProviderClient sends it. */
function oauthQueryOf(url: string): string {
  return new URL(url, BASE_URL).search.slice(1);
}

/** Sign-in, workspace step and consent, as the pages will drive them: the redirect with the code. */
async function authorizeAsMember(auth: Auth, db: Database, email: string, client?: string) {
  const clientId = client ?? (await registerClient(auth));
  const { location, verifier } = await startAuthorization(auth, clientId);
  await signUpVerified(auth, db, email);
  const signIn = await post(auth, "/sign-in/email", { email, password: PASSWORD, oauth_query: oauthQueryOf(location.href) });
  const cookie = cookiesOf(signIn);
  const workspaceStep = ((await signIn.json()) as { url: string }).url;
  const organization = await auth.api.createOrganization({
    body: { name: "Shop", slug: crypto.randomUUID() },
    headers: new Headers({ cookie }),
  });
  await post(auth, "/organization/set-active", { organizationId: organization!.id }, cookie);
  const resumed = await post(auth, "/oauth2/continue", { postLogin: true, oauth_query: oauthQueryOf(workspaceStep) }, cookie);
  const consentPage = ((await resumed.json()) as { url: string }).url;
  const consent = await post(auth, "/oauth2/consent", { accept: true, oauth_query: oauthQueryOf(consentPage) }, cookie);
  const callback = new URL(((await consent.json()) as { url: string }).url);
  return { clientId, verifier, callback, organizationId: organization!.id, workspaceStep, consentPage, cookie };
}

/** GET authorize as a signed-in browser: where Better Auth sends it next. */
async function authorizeSignedIn(auth: Auth, clientId: string, cookie: string, extra: Record<string, string> = {}) {
  const { verifier, challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "eccos:view offline_access",
    resource: RESOURCE,
    state: "state-2",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  });
  const response = await serve(auth, new Request(`${BASE_URL}/api/auth/oauth2/authorize?${query}`, { headers: { cookie } }));
  expect(response.status).toBe(302);
  return { location: new URL(response.headers.get("location")!, BASE_URL), verifier };
}

async function continueAfterWorkspace(auth: Auth, workspaceStep: URL, cookie: string): Promise<Response> {
  return post(auth, "/oauth2/continue", { postLogin: true, oauth_query: oauthQueryOf(workspaceStep.href) }, cookie);
}

function exchangeCode(auth: Auth, clientId: string, callback: URL, verifier: string): Promise<Response> {
  return tokenRequest(auth, {
    grant_type: "authorization_code",
    code: callback.searchParams.get("code")!,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
  });
}

function tokenRequest(auth: Auth, form: Record<string, string>): Promise<Response> {
  return serve(
    auth,
    new Request(`${BASE_URL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: CLIENT_ORIGIN },
      body: new URLSearchParams(form),
    }),
  );
}

function claimsOf(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload)) as Record<string, unknown>;
}

describe("authorization server metadata", () => {
  test("the root document names the console origin as issuer and what MCP clients need", async () => {
    const { auth } = await testAuth();
    const response = await serve(
      auth,
      new Request(`${BASE_URL}/.well-known/oauth-authorization-server`, { headers: { origin: CLIENT_ORIGIN } }),
    );
    expect(response.status).toBe(200);
    const document = (await response.json()) as Record<string, unknown>;
    expect(document.issuer).toBe(BASE_URL);
    expect(document.authorization_endpoint).toBe(`${BASE_URL}/api/auth/oauth2/authorize`);
    expect(document.token_endpoint).toBe(`${BASE_URL}/api/auth/oauth2/token`);
    expect(document.registration_endpoint).toBe(`${BASE_URL}/api/auth/oauth2/register`);
    expect(document.code_challenge_methods_supported).toEqual(["S256"]);
    expect(document.client_id_metadata_document_supported).toBe(true);
    expect(document.token_endpoint_auth_methods_supported).toContain("none");
    expect(document.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(document.scopes_supported).toEqual([
      "eccos:view",
      "eccos:operate",
      "eccos:send",
      "eccos:configure",
      "eccos:administer",
      "offline_access",
    ]);
    expect(document).not.toHaveProperty("introspection_endpoint");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("the issuer is the bare origin whatever path BETTER_AUTH_URL carries", async () => {
    const auth = createAuth({
      database: new Database(":memory:"),
      secret: "test-secret-32-chars-minimum-length!!",
      baseURL: "http://localhost:3000/",
      trustedOrigins: [BASE_URL],
      mcpResource: RESOURCE,
      mail: new CaptureMailSender(),
    });
    await (await getMigrations(auth.options)).runMigrations();
    const response = await serve(auth, new Request(`${BASE_URL}/.well-known/oauth-authorization-server`));
    expect(((await response.json()) as { issuer: string }).issuer).toBe(BASE_URL);
  });
});

describe("cross-origin endpoints (contract §6)", () => {
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/register",
    "/api/auth/jwks",
  ]) {
    test(`${path} answers a preflight from any origin, without credentials`, async () => {
      const { auth } = await testAuth();
      const response = await serve(
        auth,
        new Request(`${BASE_URL}${path}`, {
          method: "OPTIONS",
          headers: {
            origin: CLIENT_ORIGIN,
            "access-control-request-method": path.includes("oauth2") ? "POST" : "GET",
            "access-control-request-headers": "content-type, mcp-protocol-version",
          },
        }),
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    });
  }

  test("the JWKS answers cross-origin and sets no cookie", async () => {
    const { auth } = await testAuth();
    const response = await serve(
      auth,
      new Request(`${BASE_URL}/api/auth/jwks`, { headers: { origin: CLIENT_ORIGIN } }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("registration ignores a session cookie: the client is never owned by whoever is signed in", async () => {
    const { auth, db } = await testAuth();
    await signUpVerified(auth, db, "signed-in@corp.test");
    const cookie = cookiesOf(await post(auth, "/sign-in/email", { email: "signed-in@corp.test", password: PASSWORD }));
    const response = await serve(
      auth,
      new Request(`${BASE_URL}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: CLIENT_ORIGIN, cookie },
        body: JSON.stringify({ client_name: "Agent", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.getSetCookie()).toEqual([]);
    const owner = db.query('SELECT "userId" FROM "oauthClient"').get() as { userId: string | null };
    expect(owner.userId).toBeNull();
  });

  test("every other auth path keeps the same-origin policy", async () => {
    const { auth } = await testAuth();
    const response = await serve(
      auth,
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "OPTIONS",
        headers: { origin: CLIENT_ORIGIN, "access-control-request-method": "POST" },
      }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("refused endpoints answer as if never registered", () => {
  const NOT_SERVED = [
    "/api/auth/token",
    "/api/auth/oauth2/introspect",
    "/api/auth/oauth2/userinfo",
    "/api/auth/oauth2/end-session",
    "/api/auth/oauth2/end-session/confirm",
    "/api/auth/oauth2/get-consents",
    "/api/auth/oauth2/get-consent",
    "/api/auth/oauth2/update-consent",
    "/api/auth/oauth2/delete-consent",
    "/api/auth/oauth2/create-client",
    "/api/auth/oauth2/get-client",
    "/api/auth/oauth2/get-clients",
    "/api/auth/oauth2/update-client",
    "/api/auth/oauth2/delete-client",
    "/api/auth/oauth2/client/rotate-secret",
    "/api/auth/oauth2/client/rotate-keys",
    "/api/auth/admin/oauth2/create-client",
    "/api/auth/admin/oauth2/update-client",
    "/api/auth/admin/oauth2/resources",
    "/api/auth/admin/oauth2/resources/x/clients/y",
    "/api/auth/.well-known/oauth-authorization-server",
    "/api/auth/.well-known/openid-configuration",
    "/api/auth/.well-known/oauth-protected-resource",
    "/api/auth/.well-known/oauth-protected-resource/mcp",
    "/.well-known/openid-configuration",
  ];

  test("outside the organization endpoints, the block list is exactly contract §9's Not served", () => {
    const oauthPaths = [...BLOCKED_AUTH_ENDPOINTS].filter((p) => !p.startsWith("/api/auth/organization/"));
    const exact = NOT_SERVED.filter((p) => !BLOCKED_AUTH_PREFIXES.some((prefix) => p.startsWith(prefix)));
    expect(oauthPaths.sort()).toEqual(exact.sort());
    expect([...BLOCKED_AUTH_PREFIXES].sort()).toEqual(["/api/auth/.well-known/", "/api/auth/admin/oauth2/"]);
  });

  for (const path of NOT_SERVED) {
    for (const method of ["GET", "POST"]) {
      test(`${method} ${path}`, async () => {
        const { auth, db } = await testAuth();
        await signUpVerified(auth, db, "probe@corp.test");
        const cookie = cookiesOf(await post(auth, "/sign-in/email", { email: "probe@corp.test", password: PASSWORD }));
        const request = (p: string) =>
          new Request(`${BASE_URL}${p}`, {
            method,
            headers: { "content-type": "application/json", origin: BASE_URL, cookie },
            ...(method === "POST" ? { body: "{}" } : {}),
          });
        const refused = await serve(auth, request(path));
        const unknown = await auth.handler(request("/api/auth/no-such-endpoint"));
        expect([refused.status, refused.statusText, await refused.text()]).toEqual([
          unknown.status,
          unknown.statusText,
          await unknown.text(),
        ]);
      });
    }
  }

  test("the session is not exposed as a JWT", async () => {
    const { auth, db } = await testAuth();
    await signUpVerified(auth, db, "jwt@corp.test");
    const cookie = cookiesOf(await post(auth, "/sign-in/email", { email: "jwt@corp.test", password: PASSWORD }));
    const session = await serve(auth, new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }));
    expect(session.status).toBe(200);
    expect(session.headers.get("set-auth-jwt")).toBeNull();
  });

  test("the endpoints the flow needs are still served", () => {
    for (const path of [
      "/api/auth/oauth2/authorize",
      "/api/auth/oauth2/continue",
      "/api/auth/oauth2/consent",
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/register",
      "/api/auth/oauth2/revoke",
      "/api/auth/oauth2/public-client",
      "/api/auth/oauth2/public-client-prelogin",
      "/api/auth/jwks",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect(isBlockedAuthEndpoint(path)).toBe(false);
    }
  });
});

describe("client ID metadata documents", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function authorizeWithClientId(auth: Auth, clientId: string): Promise<Response> {
    const { challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "eccos:view",
      resource: RESOURCE,
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return serve(auth, new Request(`${BASE_URL}/api/auth/oauth2/authorize?${query}`));
  }

  test("an http, loopback or private client id is refused without a fetch", async () => {
    const { auth } = await testAuth();
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response("{}");
    }) as typeof fetch;
    for (const clientId of [
      "http://agent.example.com/client.json",
      "https://127.0.0.1/client.json",
      "https://[::1]/client.json",
      "https://10.0.0.8/client.json",
      "https://192.168.1.4/client.json",
      "https://169.254.169.254/client.json",
    ]) {
      const response = await authorizeWithClientId(auth, clientId);
      const location = response.headers.get("location") ?? "";
      expect(response.status === 400 || location.includes("error=invalid_client")).toBe(true);
    }
    expect(fetched).toEqual([]);
  });

  test("a redirect is never followed, and the document is refused", async () => {
    const { auth } = await testAuth();
    const fetched: { url: string; redirect?: string; userAgent: string | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push({ url: String(input), redirect: init?.redirect, userAgent: new Headers(init?.headers).get("user-agent") });
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } });
    }) as typeof fetch;
    const response = await authorizeWithClientId(auth, "https://agent.example.com/client.json");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_client");
    expect(fetched).toEqual([
      { url: "https://agent.example.com/client.json", redirect: "manual", userAgent: CIMD_USER_AGENT },
    ]);
  });

  const clients = (db: Database) => (db.query('SELECT count(*) AS n FROM "oauthClient"').get() as { n: number }).n;

  for (const [name, extra] of [
    ["over 5 KB", { padding: "p".repeat(6 * 1024) }],
    ["with a client_name over 100 characters", { client_name: "N".repeat(101) }],
    ["with more than 5 redirect URIs", { redirect_uris: Array.from({ length: 6 }, (_, i) => `${CLIENT_ORIGIN}/cb/${i}`) }],
    ["with a logo_uri over 512 characters", { logo_uri: `${CLIENT_ORIGIN}/${"l".repeat(512)}` }],
  ] as const) {
    test(`a document ${name} is refused and stores nothing`, async () => {
      const { auth, db } = await testAuth();
      const documents = serveMetadataDocuments(() => extra);
      try {
        const response = await authorizeWithClientId(auth, CIMD_CLIENT_ID);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe("invalid_client");
      } finally {
        documents.restore();
      }
      expect(clients(db)).toBe(0);
    });
  }

  test("a document within the limits is accepted", async () => {
    const { auth, db } = await testAuth();
    const documents = serveMetadataDocuments(() => ({ client_name: "N".repeat(100), padding: "p".repeat(3 * 1024) }));
    try {
      expect((await authorizeWithClientId(auth, CIMD_CLIENT_ID)).status).toBe(302);
    } finally {
      documents.restore();
    }
    expect(clients(db)).toBe(1);
  });

  for (const [name, path, form] of [
    ["token", "/api/auth/oauth2/token", { grant_type: "refresh_token", refresh_token: "x", client_id: CIMD_CLIENT_ID }],
    ["revoke", "/api/auth/oauth2/revoke", { token: "x", client_id: CIMD_CLIENT_ID }],
  ] as const) {
    test(`${name} never resolves a metadata document the authorization endpoint has not`, async () => {
      const { auth, db } = await testAuth();
      const documents = serveMetadataDocuments();
      try {
        const response = await serve(
          auth,
          new Request(`${BASE_URL}${path}`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", origin: CLIENT_ORIGIN },
            body: new URLSearchParams(form),
          }),
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        expect(documents.fetched).toEqual([]);
      } finally {
        documents.restore();
      }
      expect(clients(db)).toBe(0);
    });
  }

  test("the authorization endpoint allows 10 requests per minute per address", async () => {
    const { auth } = await testAuth();
    const clientId = await registerClient(auth);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await authorizeWithClientId(auth, clientId)).status);
    expect(statuses.slice(0, 10).every((status) => status === 302)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test("the transport refuses http, other methods, credentials and oversized documents", async () => {
    globalThis.fetch = (async () => new Response("x".repeat(8 * 1024 + 1))) as unknown as typeof fetch;
    await expect(cimdFetch("http://agent.example.com/c.json")).rejects.toThrow(/HTTPS/);
    await expect(cimdFetch("https://agent.example.com/c.json", { method: "POST" })).rejects.toThrow(/GET/);
    await expect(cimdFetch("https://user:pw@agent.example.com/c.json")).rejects.toThrow(/credentials/);
    await expect(cimdFetch("https://agent.example.com/c.json")).rejects.toThrow(/too large/);
  });
});

describe("authorization code with PKCE", () => {
  test("an authorize request without a session goes to sign-in with the signed query", async () => {
    const { auth } = await testAuth();
    const clientId = await registerClient(auth);
    const { location } = await startAuthorization(auth, clientId);
    expect(location.pathname).toBe("/signin");
    expect(location.searchParams.get("client_id")).toBe(clientId);
    expect(location.searchParams.get("sig")).toBeTruthy();
  });

  test("the token's audience is the MCP resource and it carries the workspace", async () => {
    const { auth, db } = await testAuth();
    const flow = await authorizeAsMember(auth, db, "owner@corp.test");
    expect(new URL(flow.workspaceStep, BASE_URL).pathname).toBe("/oauth/workspace");
    expect(new URL(flow.consentPage, BASE_URL).pathname).toBe("/oauth/consent");
    expect(flow.callback.origin + flow.callback.pathname).toBe(REDIRECT_URI);
    expect(flow.callback.searchParams.get("iss")).toBe(BASE_URL);
    const response = await tokenRequest(auth, {
      grant_type: "authorization_code",
      code: flow.callback.searchParams.get("code")!,
      code_verifier: flow.verifier,
      client_id: flow.clientId,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.getSetCookie()).toEqual([]);
    const tokens = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
    const claims = claimsOf(tokens.access_token);
    expect(claims.aud).toBe(RESOURCE);
    expect(claims.iss).toBe(BASE_URL);
    expect(claims[WORKSPACE_CLAIM]).toBe(flow.organizationId);
    expect(tokens.expires_in).toBe(600);
    expect(tokens.refresh_token).toBeTruthy();
  });

  test("a wrong PKCE verifier gets no token", async () => {
    const { auth, db } = await testAuth();
    const flow = await authorizeAsMember(auth, db, "owner@corp.test");
    const response = await tokenRequest(auth, {
      grant_type: "authorization_code",
      code: flow.callback.searchParams.get("code")!,
      code_verifier: (await pkce()).verifier,
      client_id: flow.clientId,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
    expect(response.status).toBe(400);
  });

  test("refresh is refused once the user is no longer a member of the workspace", async () => {
    const { auth, db } = await testAuth();
    const flow = await authorizeAsMember(auth, db, "owner@corp.test");
    const issued = (await (
      await tokenRequest(auth, {
        grant_type: "authorization_code",
        code: flow.callback.searchParams.get("code")!,
        code_verifier: flow.verifier,
        client_id: flow.clientId,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
      })
    ).json()) as { refresh_token: string };
    const refresh = (token: string) =>
      tokenRequest(auth, { grant_type: "refresh_token", refresh_token: token, client_id: flow.clientId, resource: RESOURCE });

    const stillMember = await refresh(issued.refresh_token);
    expect(stillMember.status).toBe(200);
    const rotated = (await stillMember.json()) as { refresh_token: string };

    db.query('DELETE FROM member WHERE "organizationId" = ?').run(flow.organizationId);
    const removed = await refresh(rotated.refresh_token);
    expect(removed.status).toBe(400);
    expect(await removed.json()).toEqual({ error: "invalid_grant" });
  });

  test("a code exchange is refused with invalid_grant once the user is no longer a member", async () => {
    const { auth, db } = await testAuth();
    const flow = await authorizeAsMember(auth, db, "owner@corp.test");
    db.query('DELETE FROM member WHERE "organizationId" = ?').run(flow.organizationId);
    const response = await exchangeCode(auth, flow.clientId, flow.callback, flow.verifier);
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({ error: "invalid_grant" });
  });
});

describe("consent is never skipped (contract §9)", () => {
  test("a repeat authorization for the same client, workspace and scopes reaches the consent page again", async () => {
    const { auth, db } = await testAuth();
    const first = await authorizeAsMember(auth, db, "owner@corp.test");
    expect((await exchangeCode(auth, first.clientId, first.callback, first.verifier)).status).toBe(200);

    const { location: workspaceStep, verifier } = await authorizeSignedIn(auth, first.clientId, first.cookie);
    expect(workspaceStep.pathname).toBe("/oauth/workspace");
    const resumed = await continueAfterWorkspace(auth, workspaceStep, first.cookie);
    expect(resumed.status).toBe(200);
    const consentPage = new URL(((await resumed.json()) as { url: string }).url, BASE_URL);
    expect(consentPage.pathname).toBe("/oauth/consent");
    expect(consentPage.searchParams.has("code")).toBe(false);

    const consent = await post(auth, "/oauth2/consent", { accept: true, oauth_query: oauthQueryOf(consentPage.href) }, first.cookie);
    const callback = new URL(((await consent.json()) as { url: string }).url);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect((await exchangeCode(auth, first.clientId, callback, verifier)).status).toBe(200);
  });

  test("an existing grant keeps refreshing after a repeat authorization", async () => {
    const { auth, db } = await testAuth();
    const first = await authorizeAsMember(auth, db, "owner@corp.test");
    const issued = (await (await exchangeCode(auth, first.clientId, first.callback, first.verifier)).json()) as {
      refresh_token: string;
    };
    const { location: workspaceStep } = await authorizeSignedIn(auth, first.clientId, first.cookie);
    await continueAfterWorkspace(auth, workspaceStep, first.cookie);
    const refreshed = await tokenRequest(auth, {
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: first.clientId,
      resource: RESOURCE,
    });
    expect(refreshed.status).toBe(200);
  });

  test("prompt=none answers consent_required at the redirect URI and issues no code", async () => {
    const { auth, db } = await testAuth();
    const first = await authorizeAsMember(auth, db, "owner@corp.test");
    const { location } = await authorizeSignedIn(auth, first.clientId, first.cookie, { prompt: "none" });
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("consent_required");
    expect(location.searchParams.get("state")).toBe("state-2");
    expect(location.searchParams.has("code")).toBe(false);
  });

  test("a client's own prompt=consent or prompt=login still works", async () => {
    const { auth, db } = await testAuth();
    const first = await authorizeAsMember(auth, db, "owner@corp.test");
    const { location } = await authorizeSignedIn(auth, first.clientId, first.cookie, { prompt: "consent" });
    expect(location.pathname).toBe("/oauth/workspace");
    const login = await authorizeSignedIn(auth, first.clientId, first.cookie, { prompt: "login" });
    expect(login.location.pathname).toBe("/signin");
  });
});

describe("the workspace step and consent, posted directly", () => {
  test("continue never binds a workspace the user has left: it goes back to the workspace step", async () => {
    const { auth, db } = await testAuth();
    const first = await authorizeAsMember(auth, db, "owner@corp.test");
    const { location: workspaceStep } = await authorizeSignedIn(auth, first.clientId, first.cookie);
    db.query('DELETE FROM member WHERE "organizationId" = ?').run(first.organizationId);
    db.query('DELETE FROM "oauthConsent"').run();

    const resumed = await continueAfterWorkspace(auth, workspaceStep, first.cookie);
    const next = new URL(((await resumed.json()) as { url: string }).url, BASE_URL);
    expect(next.pathname).toBe("/oauth/workspace");
    expect(next.searchParams.has("code")).toBe(false);
    expect(db.query('SELECT count(*) AS n FROM "oauthConsent"').get()).toEqual({ n: 0 });
  });

  test("consent posted for a workspace the user has left is refused and stores nothing", async () => {
    const { auth, db } = await testAuth();
    const first = await authorizeAsMember(auth, db, "owner@corp.test");
    const { location: workspaceStep } = await authorizeSignedIn(auth, first.clientId, first.cookie);
    const consentPage = ((await (await continueAfterWorkspace(auth, workspaceStep, first.cookie)).json()) as { url: string })
      .url;
    db.query('DELETE FROM member WHERE "organizationId" = ?').run(first.organizationId);
    db.query('DELETE FROM "oauthConsent"').run();

    const consent = await post(auth, "/oauth2/consent", { accept: true, oauth_query: oauthQueryOf(consentPage) }, first.cookie);
    expect(consent.status).toBeGreaterThanOrEqual(400);
    expect(await consent.text()).not.toContain("code=");
    expect(db.query('SELECT count(*) AS n FROM "oauthConsent"').get()).toEqual({ n: 0 });
  });

  test("another user's workspace can never become the session's workspace", async () => {
    const { auth, db } = await testAuth();
    const bob = await authorizeAsMember(auth, db, "bob@corp.test");
    await signUpVerified(auth, db, "mallory@corp.test");
    const cookie = cookiesOf(await post(auth, "/sign-in/email", { email: "mallory@corp.test", password: PASSWORD }));
    const setActive = await post(auth, "/organization/set-active", { organizationId: bob.organizationId }, cookie);
    expect(setActive.status).toBe(403);

    const { location: workspaceStep } = await authorizeSignedIn(auth, bob.clientId, cookie);
    const resumed = await continueAfterWorkspace(auth, workspaceStep, cookie);
    expect(new URL(((await resumed.json()) as { url: string }).url, BASE_URL).pathname).toBe("/oauth/workspace");
  });

  test("continue posted straight after a prior consent still reaches the consent page", async () => {
    const { auth, db } = await testAuth();
    const first = await authorizeAsMember(auth, db, "owner@corp.test");
    const resumed = await post(
      auth,
      "/oauth2/continue",
      { postLogin: true, oauth_query: oauthQueryOf(first.workspaceStep) },
      first.cookie,
    );
    expect(new URL(((await resumed.json()) as { url: string }).url, BASE_URL).pathname).toBe("/oauth/consent");
  });
});

describe("request limits on the public OAuth endpoints", () => {
  const register = (auth: Auth, body: BodyInit, headers: Record<string, string> = {}) =>
    serve(
      auth,
      new Request(`${BASE_URL}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: CLIENT_ORIGIN, ...headers },
        body,
        // @ts-expect-error Bun needs it for a streamed body; the Workers runtime ignores it.
        duplex: "half",
      }),
    );
  const metadata = (extra: Record<string, unknown>) =>
    JSON.stringify({ client_name: "Agent", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", ...extra });
  const clients = (db: Database) => (db.query('SELECT count(*) AS n FROM "oauthClient"').get() as { n: number }).n;

  test("a registration body over the cap is refused before parsing, and stores nothing", async () => {
    const { auth, db } = await testAuth();
    const response = await register(auth, metadata({ client_name: "A".repeat(OAUTH_BODY_LIMIT) }));
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await response.json()) as { error: string }).error).toBe("invalid_client_metadata");
    expect(clients(db)).toBe(0);
  });

  test("the cap holds for a streamed body that declares no length, or a smaller one", async () => {
    const { auth, db } = await testAuth();
    const big = new TextEncoder().encode(metadata({ client_name: "A".repeat(4 * OAUTH_BODY_LIMIT) }));
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < big.length; i += 1024) controller.enqueue(big.slice(i, i + 1024));
          controller.close();
        },
      });
    expect((await register(auth, stream())).status).toBe(400);
    expect((await register(auth, stream(), { "content-length": "100" })).status).toBe(400);
    expect(clients(db)).toBe(0);
  });

  test("a registration within the limits is accepted", async () => {
    const { auth, db } = await testAuth();
    const response = await register(
      auth,
      metadata({
        client_name: "N".repeat(100),
        redirect_uris: Array.from({ length: 5 }, (_, i) => `${CLIENT_ORIGIN}/cb/${i}`),
        client_uri: `${CLIENT_ORIGIN}/`,
        contacts: ["ops@agent.example.com"],
      }),
    );
    expect(response.status).toBe(201);
    expect(clients(db)).toBe(1);
  });

  const LONG_URI = `${CLIENT_ORIGIN}/${"p".repeat(512)}`;
  for (const [name, extra, error] of [
    ["client_name over 100 characters", { client_name: "N".repeat(101) }, "invalid_client_metadata"],
    ["more than 5 redirect URIs", { redirect_uris: Array.from({ length: 6 }, (_, i) => `${CLIENT_ORIGIN}/cb/${i}`) }, "invalid_redirect_uri"],
    ["a redirect URI over 512 characters", { redirect_uris: [LONG_URI] }, "invalid_redirect_uri"],
    ["a post-logout redirect URI over 512 characters", { post_logout_redirect_uris: [LONG_URI] }, "invalid_redirect_uri"],
    ["client_uri over 512 characters", { client_uri: LONG_URI }, "invalid_client_metadata"],
    ["logo_uri over 512 characters", { logo_uri: LONG_URI }, "invalid_client_metadata"],
    ["policy_uri over 512 characters", { policy_uri: LONG_URI }, "invalid_client_metadata"],
    ["tos_uri over 512 characters", { tos_uri: LONG_URI }, "invalid_client_metadata"],
    ["jwks_uri over 512 characters", { jwks_uri: LONG_URI }, "invalid_client_metadata"],
    ["more than 5 contacts", { contacts: Array.from({ length: 6 }, (_, i) => `c${i}@agent.example.com`) }, "invalid_client_metadata"],
    ["a contact over 254 characters", { contacts: [`${"c".repeat(250)}@a.example`] }, "invalid_client_metadata"],
    ["software_id over 128 characters", { software_id: "s".repeat(129) }, "invalid_client_metadata"],
    ["software_version over 128 characters", { software_version: "1".repeat(129) }, "invalid_client_metadata"],
    ["software_statement over 2048 characters", { software_statement: "j".repeat(2049) }, "invalid_client_metadata"],
    ["metadata over 1024 characters", { metadata: { note: "m".repeat(1024) } }, "invalid_client_metadata"],
  ] as const) {
    test(`registration with ${name} is refused with ${error}`, async () => {
      const { auth, db } = await testAuth();
      const response = await register(auth, metadata(extra));
      expect(response.status).toBe(400);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe(error);
      expect(body.error_description).toBeTruthy();
      expect(clients(db)).toBe(0);
    });
  }

  for (const path of ["/api/auth/oauth2/token", "/api/auth/oauth2/revoke"]) {
    test(`${path} refuses a body over the cap with invalid_request`, async () => {
      const { auth } = await testAuth();
      const response = await serve(
        auth,
        new Request(`${BASE_URL}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: CLIENT_ORIGIN },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: "x",
            refresh_token: "t".repeat(OAUTH_BODY_LIMIT),
            token: "t".repeat(OAUTH_BODY_LIMIT),
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
    });
  }
});

describe("unused registered clients are deleted", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  /** The D1 surface the cleanup uses, over bun:sqlite. */
  const d1 = (db: Database) =>
    ({
      prepare: (sql: string) => ({
        bind: (...params: string[]) => ({ run: async () => db.query(sql).run(...params) }),
      }),
    }) as unknown as D1Database;
  const age = (db: Database, clientId: string, ms: number) => {
    const at = new Date(Date.now() - ms).toISOString();
    db.query('UPDATE "oauthClient" SET "createdAt" = ?, "updatedAt" = ? WHERE "clientId" = ?').run(at, at, clientId);
  };
  const exists = (db: Database, clientId: string) =>
    db.query('SELECT 1 FROM "oauthClient" WHERE "clientId" = ?').get(clientId) !== null;

  test("an old client with no grant goes, a fresh one stays", async () => {
    const { auth, db } = await testAuth();
    const old = await registerClient(auth);
    const fresh = await registerClient(auth);
    age(db, old, DAY_MS + 60_000);
    age(db, fresh, DAY_MS - 60_000);
    await deleteUnusedOAuthClients(d1(db));
    expect(exists(db, old)).toBe(false);
    expect(exists(db, fresh)).toBe(true);
  });

  for (const kept of ["oauthConsent", "oauthRefreshToken", "oauthAccessToken"] as const) {
    test(`an old client that still holds a row in ${kept} is kept, and its grant still works`, async () => {
      const { auth, db } = await testAuth();
      const flow = await authorizeAsMember(auth, db, "owner@corp.test");
      const issued = (await (await exchangeCode(auth, flow.clientId, flow.callback, flow.verifier)).json()) as {
        refresh_token: string;
      };
      // Access tokens for the MCP resource are JWTs and never stored; an opaque one (no resource) would be.
      db.query(
        'INSERT INTO "oauthAccessToken" ("id", "token", "clientId", "userId", "expiresAt", "createdAt", "scopes") SELECT \'at\', \'opaque\', "clientId", "userId", "expiresAt", "createdAt", "scopes" FROM "oauthRefreshToken"',
      ).run();
      for (const table of ["oauthConsent", "oauthRefreshToken", "oauthAccessToken"]) {
        if (table !== kept) db.query(`DELETE FROM "${table}"`).run();
      }
      age(db, flow.clientId, 30 * DAY_MS);
      await deleteUnusedOAuthClients(d1(db));
      expect(exists(db, flow.clientId)).toBe(true);
      if (kept === "oauthRefreshToken") {
        const refreshed = await tokenRequest(auth, {
          grant_type: "refresh_token",
          refresh_token: issued.refresh_token,
          client_id: flow.clientId,
          resource: RESOURCE,
        });
        expect(refreshed.status).toBe(200);
      }
    });
  }

  test("an unused metadata-document client goes after 24 hours, and the next authorization resolves it again", async () => {
    const { auth, db } = await testAuth();
    const documents = serveMetadataDocuments();
    try {
      await startAuthorization(auth, CIMD_CLIENT_ID);
      expect(exists(db, CIMD_CLIENT_ID)).toBe(true);
      age(db, CIMD_CLIENT_ID, DAY_MS + 60_000);
      await deleteUnusedOAuthClients(d1(db));
      expect(exists(db, CIMD_CLIENT_ID)).toBe(false);

      const { location } = await startAuthorization(auth, CIMD_CLIENT_ID);
      expect(location.pathname).toBe("/signin");
      expect(exists(db, CIMD_CLIENT_ID)).toBe(true);
    } finally {
      documents.restore();
    }
  });

  test("a metadata-document client resolved again within 24 hours is kept", async () => {
    const { auth, db } = await testAuth();
    const documents = serveMetadataDocuments();
    try {
      await startAuthorization(auth, CIMD_CLIENT_ID);
      age(db, CIMD_CLIENT_ID, 30 * DAY_MS);
      // A later request: the console builds its auth instance per request, so the document is fetched again.
      const nextRequest = createAuth({
        database: db,
        secret: "test-secret-32-chars-minimum-length!!",
        baseURL: BASE_URL,
        trustedOrigins: [BASE_URL],
        mcpResource: RESOURCE,
        mail: new CaptureMailSender(),
      });
      await startAuthorization(nextRequest, CIMD_CLIENT_ID);
      await deleteUnusedOAuthClients(d1(db));
      expect(exists(db, CIMD_CLIENT_ID)).toBe(true);
    } finally {
      documents.restore();
    }
  });

  test("a metadata-document client holding a grant is never deleted, and its grant still works", async () => {
    const { auth, db } = await testAuth();
    const documents = serveMetadataDocuments();
    try {
      const flow = await authorizeAsMember(auth, db, "owner@corp.test", CIMD_CLIENT_ID);
      const issued = (await (await exchangeCode(auth, flow.clientId, flow.callback, flow.verifier)).json()) as {
        refresh_token: string;
      };
      age(db, CIMD_CLIENT_ID, 30 * DAY_MS);
      await deleteUnusedOAuthClients(d1(db));
      expect(exists(db, CIMD_CLIENT_ID)).toBe(true);
      const refreshed = await tokenRequest(auth, {
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        client_id: CIMD_CLIENT_ID,
        resource: RESOURCE,
      });
      expect(refreshed.status).toBe(200);
    } finally {
      documents.restore();
    }
  });
});

describe("resuming the authorization", () => {
  test("after email verification: the verification link returns to the pending authorization", async () => {
    const { auth, mail } = await testAuth();
    const clientId = await registerClient(auth);
    const { location } = await startAuthorization(auth, clientId);
    const pending = pendingAuthorizationURL(location.search)!;
    expect(pending.startsWith("/api/auth/oauth2/authorize?")).toBe(true);

    await post(auth, "/sign-up/email", {
      email: "new@corp.test",
      password: PASSWORD,
      name: "New",
      callbackURL: pending,
      oauth_query: oauthQueryOf(location.href),
    });
    const link = new URL(mail.sent.at(-1)!.variables.url!);
    expect(link.searchParams.get("callbackURL")).toBe(pending);

    const verified = await serve(auth, new Request(link));
    expect(verified.status).toBe(302);
    const cookie = cookiesOf(verified);
    const resumed = await serve(
      auth,
      new Request(new URL(verified.headers.get("location")!, BASE_URL), { headers: { cookie } }),
    );
    expect(resumed.status).toBe(302);
    expect(new URL(resumed.headers.get("location")!, BASE_URL).pathname).toBe("/oauth/workspace");
  });

  test("after TOTP: the second factor continues to the workspace step", async () => {
    const { auth, db, mail } = await testAuth();
    const email = "mfa@corp.test";
    await signUpVerified(auth, db, email);
    const first = cookiesOf(await post(auth, "/sign-in/email", { email, password: PASSWORD }));
    await post(auth, "/two-factor/send-enable-code", { password: PASSWORD }, first);
    const enable = await post(auth, "/two-factor/enable", { password: PASSWORD, emailCode: mail.sent.at(-1)!.variables.code }, first);
    const secret = rawSecret(((await enable.json()) as { totpURI: string }).totpURI);
    const code = async () => (await auth.api.generateTOTP({ body: { secret } })).code;
    expect((await post(auth, "/two-factor/verify-totp", { code: await code() }, first)).status).toBe(200);
    db.query('UPDATE "twoFactor" SET "lastTotpStep" = 0').run();

    const clientId = await registerClient(auth);
    const { location } = await startAuthorization(auth, clientId);
    const oauth_query = oauthQueryOf(location.href);
    const challenged = await post(auth, "/sign-in/email", { email, password: PASSWORD, oauth_query });
    expect(((await challenged.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const verified = await post(auth, "/two-factor/verify-totp", { code: await code(), oauth_query }, cookiesOf(challenged));
    expect(verified.status).toBe(200);
    const next = ((await verified.json()) as { url?: string }).url;
    expect(new URL(next!, BASE_URL).pathname).toBe("/oauth/workspace");
  });
});

describe("withPendingAuthorization", () => {
  test("adds the signed parameters to a page link, keeping its own query", () => {
    const signed = "?client_id=a&redirect=%2Fx&ba_param=client_id&sig=s";
    expect(withPendingAuthorization("/signup", signed)).toBe("/signup?client_id=a&ba_param=client_id&sig=s");
    expect(withPendingAuthorization("/signin?redirect=%2Finvitations", signed)).toBe(
      "/signin?redirect=%2Finvitations&client_id=a&ba_param=client_id&sig=s",
    );
    expect(withPendingAuthorization("/signup", "?redirect=%2Fx")).toBe("/signup");
  });
});

describe("pendingAuthorizationURL", () => {
  test("keeps only the signed parameters, and nothing without a signature", () => {
    expect(pendingAuthorizationURL("?redirect=%2Fnumbers")).toBeUndefined();
    expect(pendingAuthorizationURL("?client_id=a&sig=s")).toBeUndefined();
    expect(pendingAuthorizationURL("?client_id=a&redirect=%2Fx&ba_param=ba_param&ba_param=client_id&sig=s")).toBe(
      "/api/auth/oauth2/authorize?client_id=a&ba_param=ba_param&ba_param=client_id&sig=s",
    );
  });
});

/** The raw secret behind an otpauth:// URI, which carries it base32-encoded. */
function rawSecret(totpURI: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of new URL(totpURI).searchParams.get("secret")!.replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes = bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2));
  return new TextDecoder().decode(new Uint8Array(bytes));
}
