/**
 * Better Auth foundation tests (eccos-0x0.2).
 *
 * Exercises the identity plane against an in-memory SQLite database via the
 * same `createAuth` factory the Worker uses with the D1 binding: sign-up,
 * email verification, sign-in, session lookup, tampered/missing cookies,
 * origin checking, sign-out, and the Organization plugin wiring. The schema is
 * applied programmatically with Better Auth's `getMigrations` — the same
 * statements that ship as `migrations/0001_better_auth_schema.sql` for D1.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth, buildInvitationAcceptLink } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";
import { authConfigFromEnv } from "../src/auth/config";

const SECRET = "test-secret-32-chars-minimum-length!!";
const BASE_URL = "http://localhost:3000";

async function createTestAuth(mail?: CaptureMailSender) {
  const db = new Database(":memory:");
  const auth = createAuth({
    database: db,
    secret: SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mail: mail ?? new CaptureMailSender(),
  });
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return { auth, db, toBeCreated, toBeAdded };
}

function cookieFrom(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0] ?? null;
}

async function signUpUser(
  auth: ReturnType<typeof createAuth>,
  email: string,
  password: string,
): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password, name: "Test User" }),
    }),
  );
}

async function signInUser(
  auth: ReturnType<typeof createAuth>,
  email: string,
  password: string,
): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password }),
    }),
  );
}

describe("auth schema", () => {
  test("migrations create core and organization tables", async () => {
    const { db, toBeCreated } = await createTestAuth();
    expect(toBeCreated.map((t) => t.table).sort()).toEqual([
      "account",
      "invitation",
      "member",
      "organization",
      "rateLimit",
      "session",
      "twoFactor",
      "user",
      "verification",
    ]);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const table of ["user", "session", "account", "verification", "organization", "member", "invitation", "rateLimit", "twoFactor"]) {
      expect(names).toContain(table);
    }
    // Organization plugin session field (active-org UX state).
    const sessionCols = (db.query("PRAGMA table_info(session)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(sessionCols).toContain("activeOrganizationId");
  });
});

describe("password policy", () => {
  test("server-side minLength rejects a short password on sign-up (PASSWORD_TOO_SHORT)", async () => {
    const { auth } = await createTestAuth();
    const res = await signUpUser(auth, "short@example.com", "short");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("PASSWORD_TOO_SHORT");
    // Fail closed: no user row, no session cookie.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a 10-character password is accepted (boundary)", async () => {
    const { auth } = await createTestAuth();
    const res = await signUpUser(auth, "boundary@example.com", "1234567890");
    // 10 chars is allowed; sign-up succeeds (verification email sent, no session yet).
    expect(res.status).toBe(200);
  });
});

describe("invitation accept link (eccos-omv)", () => {
  test("buildInvitationAcceptLink uses the query-param route /invitations?id=", () => {
    expect(buildInvitationAcceptLink("http://localhost:3000", "inv_123")).toBe(
      "http://localhost:3000/invitations?id=inv_123",
    );
    expect(buildInvitationAcceptLink("https://app.eccos.chat", "inv_456")).toBe(
      "https://app.eccos.chat/invitations?id=inv_456",
    );
  });

  test("the invitation email delivered by the organization plugin carries the query-param link", async () => {
    const mail = new CaptureMailSender();
    const { auth, db } = await createTestAuth(mail);
    const cookie = await verifiedSessionCookie(auth, db, "inviter@example.com");

    const org = (await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers: new Headers({ cookie }),
    })) as { id?: string };
    const invitation = (await auth.api.createInvitation({
      body: { email: "invitee@example.com", role: "viewer", organizationId: org.id! },
      headers: new Headers({ cookie }),
    })) as { id?: string };

    expect(invitation.id).toBeTruthy();
    const email = mail.sent.find((m) => m.to === "invitee@example.com");
    expect(email).toBeTruthy();
    expect(email!.template).toBe("invite-member");
    // The only existing route is /invitations with ?id= (createFileRoute("/invitations")).
    expect(email!.variables.url).toBe(`${BASE_URL}/invitations?id=${invitation.id}`);
    // A path-segment link would dead-end on a non-existent route.
    expect(email!.variables.url).not.toContain(`${BASE_URL}/invitations/${invitation.id}`);
  });
});

describe("sign-up and email verification", () => {
  test("sign-up requires email verification and sends the verification email", async () => {
    const mail = new CaptureMailSender();
    const { auth } = await createTestAuth(mail);
    const res = await signUpUser(auth, "alice@example.com", "correct-horse-battery");
    expect(res.status).toBe(200);
    // With `requireEmailVerification`, sign-up does NOT issue a session until
    // the address is verified (token: null in the response).
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { token: string | null };
    expect(body.token).toBeNull();
    // Verification email produced by the application-owned adapter.
    expect(mail.sent.length).toBe(1);
    expect(mail.sent[0]?.to).toBe("alice@example.com");
    expect(mail.sent[0]?.template).toBe("verify-email");
    expect(mail.sent[0]?.variables.url).toContain("http");
    // The Idempotency-Key is a SHA-256 digest, never the raw token.
    expect(mail.sent[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  test("unverified sign-in fails closed with EMAIL_NOT_VERIFIED", async () => {
    const { auth } = await createTestAuth();
    await signUpUser(auth, "bob@example.com", "correct-horse-battery");
    const signIn = await signInUser(auth, "bob@example.com", "correct-horse-battery");
    expect(signIn.status).toBe(403);
    const body = (await signIn.json()) as { code?: string };
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
    expect(signIn.headers.get("set-cookie")).toBeNull();
  });
});

/**
 * Sign up a verified user and return the session cookie from sign-in.
 * (Module scope: shared by the session, origin, and organization suites.)
 */
async function verifiedSessionCookie(
  auth: ReturnType<typeof createAuth>,
  db: Database,
  email: string,
): Promise<string> {
  await signUpUser(auth, email, "correct-horse-battery");
  // Simulate completed email verification (the verify flow itself is exercised
  // by the captured-mail assertion in the sign-up suite).
  db.query('UPDATE user SET "emailVerified" = 1').run();
  const signIn = await signInUser(auth, email, "correct-horse-battery");
  expect(signIn.status).toBe(200);
  const setCookie = signIn.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
  return setCookie!.split(";")[0]!;
}

describe("sessions", () => {
  test("sign-in with correct password issues a working session; get-session resolves it", async () => {
    const { auth, db } = await createTestAuth();
    const cookie = await verifiedSessionCookie(auth, db, "carol@example.com");

    const sessionRes = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }),
    );
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as {
      user?: { email?: string; emailVerified?: boolean };
    };
    expect(session.user?.email).toBe("carol@example.com");
  });

  test("get-session without a cookie fails closed (null session)", async () => {
    const { auth } = await createTestAuth();
    const res = await auth.handler(new Request(`${BASE_URL}/api/auth/get-session`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });

  test("get-session with a tampered cookie fails closed (null session)", async () => {
    const { auth, db } = await createTestAuth();
    const cookie = await verifiedSessionCookie(auth, db, "dave@example.com");
    const tampered = cookie.replace(/[A-Za-z0-9_%]+$/, "tamperedtamperedtampered");

    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie: tampered } }),
    );
    const body = await res.json();
    expect(body).toBeNull();
  });

  test("sign-out revokes the session; subsequent get-session is null", async () => {
    const { auth, db } = await createTestAuth();
    const cookie = await verifiedSessionCookie(auth, db, "erin@example.com");

    const signOut = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, origin: BASE_URL },
      }),
    );
    expect(signOut.status).toBe(200);

    const after = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }),
    );
    const body = await after.json();
    expect(body).toBeNull();
  });

  test("expired sessions fail closed", async () => {
    const { auth, db } = await createTestAuth();
    const cookie = await verifiedSessionCookie(auth, db, "frank@example.com");
    // Force-expire every session row.
    db.query("UPDATE session SET expiresAt = ?").run(new Date(Date.now() - 1000).toISOString());
    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }),
    );
    const body = await res.json();
    expect(body).toBeNull();
  });
});

describe("origin / CSRF protection", () => {
  test("sign-in with a cross-origin Origin header is rejected", async () => {
    const { auth, db } = await createTestAuth();
    await verifiedSessionCookie(auth, db, "gina@example.com");
    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ email: "gina@example.com", password: "correct-horse-battery" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_ORIGIN");
  });
});

describe("organization plugin", () => {
  test("an organization can be created through the auth handler", async () => {
    const { auth, db } = await createTestAuth();
    const cookie = await verifiedSessionCookie(auth, db, "org-owner@example.com");

    const createRes = await auth.handler(
      new Request(`${BASE_URL}/api/auth/organization/create`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: BASE_URL },
        body: JSON.stringify({ name: "Acme Widgets", slug: "acme-widgets" }),
      }),
    );
    expect(createRes.status).toBe(200);
    const org = (await createRes.json()) as { name?: string; slug?: string };
    expect(org.slug).toBe("acme-widgets");

    // The active organization lands in the session (UX state only).
    const sessionRes = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }),
    );
    const session = (await sessionRes.json()) as {
      session?: { activeOrganizationId?: string | null };
    };
    expect(session.session?.activeOrganizationId).toBeTruthy();
  });
});

describe("authConfigFromEnv", () => {
  test("throws when no secret is configured for an https (production-like) origin", () => {
    expect(() =>
      authConfigFromEnv({ DB: {} as D1Database, BETTER_AUTH_SECRET: "" }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  test("localhost development trusts only the local origins", () => {
    const config = authConfigFromEnv({
      DB: {} as D1Database,
      BETTER_AUTH_URL: "http://localhost:3000",
    });
    expect(config.trustedOrigins).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      // Vite dev server default port — the browser side of local development.
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
  });
});
