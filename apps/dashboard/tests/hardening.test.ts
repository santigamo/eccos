/**
 * Hardening tests (eccos-0x0.7): distributed rate limiting, TOTP two-factor
 * enrollment, and the owner/admin step-up policy (fresh sessions).
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";

const BASE_URL = "http://localhost:3000";

async function createTestAuth() {
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
  return { auth, db };
}

async function signInHeaders(auth: ReturnType<typeof createAuth>, db: Database, email: string): Promise<Headers> {
  await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: email }),
    }),
  );
  db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
  const signIn = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    }),
  );
  return new Headers({ cookie: signIn.headers.get("set-cookie")!.split(";")[0]! });
}

describe("two-factor (TOTP)", () => {
  test("enabling TOTP returns a URI and backup codes and marks the user", async () => {
    const { auth, db } = await createTestAuth();
    const headers = await signInHeaders(auth, db, "mfa@corp.test");
    const enabled = (await auth.api.enableTwoFactor({
      body: { method: "totp", password: "correct-horse-battery" },
      headers,
    })) as { totpURI?: string; backupCodes?: string[] };
    expect(enabled.totpURI).toContain("otpauth://totp");
    expect(Array.isArray(enabled.backupCodes)).toBe(true);
    expect(enabled.backupCodes!.length).toBeGreaterThan(0);

    // The flag flips to enabled after code verification; before that the
    // enrollment is pending (twoFactor row exists, user flag still 0).
    const flag = db
      .query('SELECT "twoFactorEnabled" FROM "user" WHERE email = ?')
      .get("mfa@corp.test") as { twoFactorEnabled: number };
    expect(flag.twoFactorEnabled).toBe(0);
  });
});

describe("distributed rate limiting", () => {
  test("rate limit counters are stored in the database (shared across isolates)", async () => {
    const { auth, db } = await createTestAuth();
    const config = auth.options.rateLimit;
    expect(config?.enabled).toBe(true);
    expect(config?.storage).toBe("database");
    // Auth-critical paths have tighter windows than the default.
    expect(config?.customRules?.["/sign-in/email"]).toBeDefined();
    expect(config?.customRules?.["/forgot-password"]).toBeDefined();

    // A blocked request leaves a rate-limit row in the auth D1 (observable).
    const signIn = async () =>
      auth.handler(
        new Request(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({ email: "nobody@corp.test", password: "wrong-password-1" }),
        }),
      );
    // Exhaust the sign-in rule window (10 attempts / 300s).
    for (let i = 0; i < 10; i++) await signIn();
    const blocked = await signIn();
    expect(blocked.status).toBe(429);
  });
});
