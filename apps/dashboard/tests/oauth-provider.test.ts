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
import { pendingAuthorizationURL } from "../src/auth/pending-authorization";
import { oauthCrossOriginApi } from "../src/server/oauth-cross-origin";

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
  if (pathname.startsWith("/api/auth/")) return auth.handler(request);
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
async function authorizeAsMember(auth: Auth, db: Database, email: string) {
  const clientId = await registerClient(auth);
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
  return { clientId, verifier, callback, organizationId: organization!.id, workspaceStep, consentPage };
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

  test("the transport refuses http, other methods, credentials and oversized documents", async () => {
    globalThis.fetch = (async () => new Response("x".repeat(70 * 1024))) as unknown as typeof fetch;
    await expect(cimdFetch("http://agent.example.com/c.json")).rejects.toThrow(/HTTPS/);
    await expect(cimdFetch("https://agent.example.com/c.json", { method: "POST" })).rejects.toThrow(/GET/);
    await expect(cimdFetch("https://user:pw@agent.example.com/c.json")).rejects.toThrow(/credentials/);
    const response = await cimdFetch("https://agent.example.com/c.json");
    await expect(response.text()).rejects.toThrow(/too large/);
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
    expect(removed.status).toBe(403);
    expect(await removed.text()).not.toContain("access_token");
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
