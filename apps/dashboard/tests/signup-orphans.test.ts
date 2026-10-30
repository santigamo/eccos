/**
 * Sign-up never strands a user without its credential account (eccos-nlzu):
 * D1 runs Better Auth's user + account inserts non-atomically.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";

const BASE_URL = "http://localhost:3000";
const EMAIL = "stefan@example.com";
const PASSWORD = "correct-horse-battery";

async function setup() {
  const db = new Database(":memory:");
  const auth = createAuth({
    database: db,
    secret: "test-secret-32-chars-minimum-length!!",
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mail: new CaptureMailSender(),
  });
  await (await getMigrations(auth.options)).runMigrations();
  // Like D1: no transactions, so the user and account inserts are separate.
  const ctx = await auth.$context;
  ctx.adapter.transaction = (fn) => fn(ctx.adapter);
  const signUp = () =>
    auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Stefan" }),
      }),
    );
  const counts = () => ({
    users: db.query('SELECT count(*) AS n FROM "user"').get() as { n: number },
    accounts: db.query(`SELECT count(*) AS n FROM account WHERE "providerId" = 'credential'`).get() as {
      n: number;
    },
  });
  return { db, signUp, counts };
}

describe("sign-up orphan guard", () => {
  test("a failed credential insert leaves no user, and a retry completes sign-up", async () => {
    const { db, signUp, counts } = await setup();
    db.run(`CREATE TRIGGER fail_account BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'D1_ERROR'); END`);

    const failed = await signUp();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(counts()).toEqual({ users: { n: 0 }, accounts: { n: 0 } });

    db.run("DROP TRIGGER fail_account");
    const retry = await signUp();
    expect(retry.status).toBe(200);
    expect(counts()).toEqual({ users: { n: 1 }, accounts: { n: 1 } });
  });

  test("a pre-existing orphan is replaced on the next sign-up", async () => {
    const { db, signUp, counts } = await setup();
    db.run(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('orphan', 'Stefan', ?, 0, ?, ?)`,
      [EMAIL, new Date().toISOString(), new Date().toISOString()],
    );

    expect((await signUp()).status).toBe(200);
    expect(counts()).toEqual({ users: { n: 1 }, accounts: { n: 1 } });
    expect(db.query('SELECT id FROM "user"').get()).not.toEqual({ id: "orphan" });
  });

  test("an existing complete account is left alone", async () => {
    const { signUp, counts } = await setup();
    expect((await signUp()).status).toBe(200);
    expect((await signUp()).status).toBe(200);
    expect(counts()).toEqual({ users: { n: 1 }, accounts: { n: 1 } });
  });
});
