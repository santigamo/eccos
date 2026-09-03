/**
 * Switching workspace is decided on the SERVER (eccos-c0d, contract §1).
 *
 * The shell's workspace control sends an organization id from the browser. That
 * id is UX input and nothing else: `selectOrganization` re-derives the session
 * server-side and runs the id through `verifyMembership` before it is ever
 * stored, so the new control adds a button, not a trust surface.
 *
 * These run the REAL server function against a real Better Auth on bun:sqlite —
 * same auth configuration the Worker builds (`authConfigFromEnv`), so the
 * session cookies the test mints are the ones the server function reads. The
 * `getRequest()` seam is mutable here, which is what lets a test speak as a
 * specific signed-in identity.
 */

import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";

const BASE_URL = "http://localhost:3000";

// One object, mutated in place: `organizations.ts` binds `env` at import time,
// so the test must not replace it.
const fakeEnv: { DB?: unknown; BETTER_AUTH_URL?: string } = { BETTER_AUTH_URL: BASE_URL };
let currentRequest = new Request(`${BASE_URL}/`);

installServerFnMocks({ env: fakeEnv, getRequest: () => currentRequest });

const { selectOrganization } = await import("../src/organizations");
const { createAuth } = await import("../src/auth/auth");
const { CaptureMailSender } = await import("../src/auth/mail");
const { authConfigFromEnv } = await import("../src/auth/config");

/**
 * One database, one auth configuration — the test's auth instance and the one
 * the server function builds internally must agree on both, or the cookies do
 * not validate.
 */
async function createTestAuth() {
  const db = new Database(":memory:");
  fakeEnv.DB = db;
  const auth = createAuth({ ...authConfigFromEnv(fakeEnv as never), mail: new CaptureMailSender() });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return { auth, db };
}

async function signIn(
  auth: Awaited<ReturnType<typeof createTestAuth>>["auth"],
  db: Database,
  email: string,
): Promise<Headers> {
  await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: email }),
    }),
  );
  db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
  const res = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    }),
  );
  expect(res.status).toBe(200);
  return new Headers({ cookie: res.headers.get("set-cookie")!.split(";")[0]! });
}

/** Speak as this identity for the next server-function call. */
function actAs(headers: Headers) {
  currentRequest = new Request(`${BASE_URL}/`, { headers });
}

function storedActiveOrg(db: Database, userId?: string): string | null {
  const rows = db
    .query('SELECT "activeOrganizationId" AS active, "userId" AS uid FROM session')
    .all() as Array<{ active: string | null; uid: string }>;
  const row = userId ? rows.find((r) => r.uid === userId) : rows[0];
  return row?.active ?? null;
}

/**
 * Organization slugs in these fixtures are minted, never chosen.
 *
 * Better Auth's `createOrganization` still REQUIRES a slug (the column is
 * `not null unique`), but the console no longer lets a customer supply one:
 * `src/organizations.ts` mints `crypto.randomUUID()`. The fixtures mirror that
 * so nothing here can quietly start depending on a readable slug again.
 */
const mintSlug = () => crypto.randomUUID();

describe("selectOrganization: the switch is validated server-side", () => {
  test("a member switches, and the session is repointed", async () => {
    const { auth, db } = await createTestAuth();
    const headers = await signIn(auth, db, "both@corp.test");
    const one = (await auth.api.createOrganization({
      body: { name: "One", slug: mintSlug() },
      headers,
    })) as { id?: string };
    const two = (await auth.api.createOrganization({
      body: { name: "Two", slug: mintSlug() },
      headers,
    })) as { id?: string };

    actAs(headers);
    const result = await selectOrganization({ data: { organizationId: one!.id! } });
    expect(result.ok).toBe(true);
    expect(storedActiveOrg(db)).toBe(one!.id!);

    // And back again — a switch is not a one-way door, which is the whole
    // point of the control this covers.
    actAs(headers);
    expect((await selectOrganization({ data: { organizationId: two!.id! } })).ok).toBe(true);
    expect(storedActiveOrg(db)).toBe(two!.id!);
  });

  test("an organization the user does not belong to is REFUSED", async () => {
    const { auth, db } = await createTestAuth();
    const ownerHeaders = await signIn(auth, db, "owner@corp.test");
    const foreign = (await auth.api.createOrganization({
      body: { name: "Acme", slug: mintSlug() },
      headers: ownerHeaders,
    })) as { id?: string };

    const outsiderHeaders = await signIn(auth, db, "outsider@corp.test");
    const outsiderOrg = (await auth.api.createOrganization({
      body: { name: "Initech", slug: mintSlug() },
      headers: outsiderHeaders,
    })) as { id?: string };
    actAs(outsiderHeaders);
    await selectOrganization({ data: { organizationId: outsiderOrg!.id! } });
    const outsiderId = (
      db.query("SELECT id FROM user WHERE email = ?").get("outsider@corp.test") as { id: string }
    ).id;
    expect(storedActiveOrg(db, outsiderId)).toBe(outsiderOrg!.id!);

    // The forged claim: a real organization id the caller is not a member of.
    actAs(outsiderHeaders);
    const refused = await selectOrganization({ data: { organizationId: foreign!.id! } });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain("not a member");
    // And nothing moved: the session stays pointed where it was.
    expect(storedActiveOrg(db, outsiderId)).toBe(outsiderOrg!.id!);
  });

  test("a fabricated organization id is refused the same way", async () => {
    const { auth, db } = await createTestAuth();
    const headers = await signIn(auth, db, "sole@corp.test");
    await auth.api.createOrganization({ body: { name: "Sole", slug: mintSlug() }, headers });

    actAs(headers);
    const refused = await selectOrganization({ data: { organizationId: "org-does-not-exist" } });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain("not a member");
  });

  /**
   * TRIPWIRE for the shared server-fn fake. Do not delete; do not weaken.
   *
   * The invariant: the suite's `createServerFn` fake RUNS `.validator()`. A
   * non-string `organizationId` is refused by the strict schema and THROWS
   * before the handler ever runs. Under a fake that skipped validation the
   * value would reach the handler and come back as an ordinary `{ok:false}`
   * refusal, so `.rejects` would fail — which is precisely how a divergent
   * fake in an earlier-evaluating file would show up here. If this goes red,
   * fix `./helpers/server-fn-mocks`, not this test.
   */
  test("a malformed organizationId is refused by the schema, not the handler", async () => {
    // Wrapped in an async IIFE deliberately: the fake runs the validator
    // synchronously, so the refusal arrives as a THROW rather than a rejected
    // promise. The wrapper accepts either, so the tripwire keeps working if
    // TanStack ever moves validation behind the promise.
    await expect(
      (async () => selectOrganization({ data: { organizationId: 42 } as never }))(),
    ).rejects.toThrow();
  });

  test("an anonymous request cannot select anything", async () => {
    const { auth, db } = await createTestAuth();
    const headers = await signIn(auth, db, "owner2@corp.test");
    const org = (await auth.api.createOrganization({
      body: { name: "Globex", slug: mintSlug() },
      headers,
    })) as { id?: string };

    // No cookie at all.
    currentRequest = new Request(`${BASE_URL}/`);
    const refused = await selectOrganization({ data: { organizationId: org!.id! } });
    expect(refused.ok).toBe(false);
  });
});
