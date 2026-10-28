/**
 * Identity fast path: one joined session read + one joined membership read per
 * Request, permissions evaluated locally, nothing shared across Requests.
 * Runs against the real Better Auth factory on in-memory SQLite, counting the
 * statements that reach the database.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";
import { ForbiddenError, requirePermission, resolveMemberships } from "../src/auth/tenant";

const BASE_URL = "http://localhost:3000";

async function setup() {
  const db = new Database(":memory:");
  const auth = createAuth({
    database: db,
    secret: "test-secret-32-chars-minimum-length!!",
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mail: new CaptureMailSender(),
  });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  const email = "member@corp.test";
  const json = { "content-type": "application/json", origin: BASE_URL };
  const credentials = { email, password: "correct-horse-battery" };
  await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ ...credentials, name: "Member" }),
    }),
  );
  db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
  const signIn = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: json,
      body: JSON.stringify(credentials),
    }),
  );
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
  const request = () => new Request(`${BASE_URL}/`, { headers: { cookie } }).headers;

  const org = (await auth.api.createOrganization({
    body: { name: "Acme", slug: crypto.randomUUID() },
    headers: request(),
  })) as { id: string };
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: request() });

  const setRole = (role: string) =>
    db.query("UPDATE member SET role = ? WHERE organizationId = ?").run(role, org.id);

  // Count statements only from here on.
  let statements = 0;
  for (const method of ["prepare", "query"] as const) {
    const original = db[method].bind(db) as (sql: string) => unknown;
    (db as unknown as Record<string, unknown>)[method] = (sql: string) => {
      statements += 1;
      return original(sql);
    };
  }
  const count = () => statements;
  const reset = () => {
    statements = 0;
  };
  return { auth, db, orgId: org.id, request, setRole, count, reset };
}

describe("identity fast path", () => {
  test("a protected read issues one session and one membership statement, however often it asks", async () => {
    const { auth, orgId, request, count, reset } = await setup();
    reset();
    const headers = request();

    expect(await requirePermission(auth, headers, undefined, "view")).toBe(orgId);
    expect(await requirePermission(auth, headers, undefined, "view")).toBe(orgId);
    expect(await resolveMemberships(auth, headers)).toEqual([{ id: orgId, name: "Acme" }]);

    expect(count()).toBe(2);
  });

  test("concurrent callers of one Request share a single membership query", async () => {
    const { auth, request, count, reset } = await setup();
    reset();
    const headers = request();

    await Promise.all([
      requirePermission(auth, headers, undefined, "view"),
      requirePermission(auth, headers, undefined, "operate"),
      resolveMemberships(auth, headers),
    ]);

    expect(count()).toBe(2);
  });

  test("distinct Requests share no state", async () => {
    const { auth, request, count, reset } = await setup();
    reset();

    await requirePermission(auth, request(), undefined, "view");
    await requirePermission(auth, request(), undefined, "view");

    expect(count()).toBe(4);
  });

  test("a role demotion is seen on the next request", async () => {
    const { auth, request, setRole } = await setup();
    await requirePermission(auth, request(), undefined, "erase");

    setRole("viewer");

    const err = await requirePermission(auth, request(), undefined, "operate").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.reason).toBe("missing-permission");
    expect(await requirePermission(auth, request(), undefined, "view")).toBeTruthy();
  });

  test("a removed member is refused on the next request", async () => {
    const { auth, db, orgId, request } = await setup();
    await requirePermission(auth, request(), undefined, "view");

    db.query("DELETE FROM member WHERE organizationId = ?").run(orgId);

    const err = await requirePermission(auth, request(), orgId, "view").catch((e) => e);
    expect(err.reason).toBe("not-a-member");
    // Falling back to the session's stored active organization fails the same way.
    const stored = await requirePermission(auth, request(), undefined, "view").catch((e) => e);
    expect(stored.reason).toBe("not-a-member");
  });

  test("an unknown role grants nothing", async () => {
    const { auth, request, setRole } = await setup();
    setRole("superuser");

    const err = await requirePermission(auth, request(), undefined, "view").catch((e) => e);
    expect(err.reason).toBe("missing-permission");
  });

  test("comma-separated roles grant the union, like Better Auth", async () => {
    const { auth, request, setRole } = await setup();
    setRole("viewer,operator");

    expect(await requirePermission(auth, request(), undefined, "operate")).toBeTruthy();
    const err = await requirePermission(auth, request(), undefined, "configure").catch((e) => e);
    expect(err.reason).toBe("missing-permission");
  });

  test("a forged organization id is not a membership", async () => {
    const { auth, request } = await setup();

    const err = await requirePermission(auth, request(), "org-forged", "view").catch((e) => e);
    expect(err.reason).toBe("not-a-member");
  });

  test("a missing session is unauthorized", async () => {
    const { auth } = await setup();

    await expect(
      requirePermission(auth, new Headers(), undefined, "view"),
    ).rejects.toThrow(/authentication required/);
  });
});
