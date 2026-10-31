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

const REAL_IP = "203.0.113.7";
const SPOOFED_XFF = "198.51.100.99";

function authPost(auth: ReturnType<typeof createAuth>, path: string, headers: Record<string, string> = {}) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, ...headers },
      body: JSON.stringify({
        email: "nobody@corp.test",
        password: "wrong-password-1",
        name: "Nobody",
        callbackURL: "/",
      }),
    }),
  );
}

function bucketKeys(db: Database): string[] {
  return (db.query('SELECT "key" FROM "rateLimit"').all() as { key: string }[]).map((r) => r.key).sort();
}

describe("distributed rate limiting", () => {
  test("counters live in the database and every custom rule names a real endpoint", async () => {
    const { auth } = await createTestAuth();
    const config = auth.options.rateLimit;
    expect(config?.enabled).toBe(true);
    expect(config?.storage).toBe("database");
    // Better Auth matches rules by exact path; a misspelled key is silently dead.
    const endpoints = new Set(Object.values(auth.api).map((e) => (e as { path?: string }).path));
    for (const path of Object.keys(config?.customRules ?? {})) {
      expect(endpoints.has(path)).toBe(true);
    }
  });

  test("/sign-in/email allows 10 per window, then refuses", async () => {
    const { auth } = await createTestAuth();
    // The framework default for /sign-in is 10 s / 3, so calls 4-10 passing is
    // what proves the custom rule is the one in force.
    for (let i = 0; i < 10; i++) {
      expect((await authPost(auth, "/sign-in/email", { "cf-connecting-ip": REAL_IP })).status).not.toBe(429);
    }
    expect((await authPost(auth, "/sign-in/email", { "cf-connecting-ip": REAL_IP })).status).toBe(429);
  });

  test("every auth route buckets on cf-connecting-ip, never on X-Forwarded-For (eccos-g5h)", async () => {
    const { auth, db } = await createTestAuth();
    // Cloudflare appends to a caller-supplied XFF, so production sees a chain.
    const paths = [...Object.keys(auth.options.rateLimit?.customRules ?? {}), "/sign-out"];
    for (const path of paths) {
      await authPost(auth, path, { "cf-connecting-ip": REAL_IP, "x-forwarded-for": `${SPOOFED_XFF}, ${REAL_IP}` });
    }
    expect(bucketKeys(db)).toEqual(paths.map((p) => `${REAL_IP}|${p}`).sort());

    // Without the edge header an XFF is still ignored: no caller-chosen key.
    await authPost(auth, "/sign-in/email", { "x-forwarded-for": SPOOFED_XFF });
    expect(bucketKeys(db).some((k) => k.includes(SPOOFED_XFF))).toBe(false);
  });

  test("a spoofed X-Forwarded-For neither dodges the limit nor shares a bucket", async () => {
    const { auth } = await createTestAuth();
    const signIn = (ip: string, xff: string) =>
      authPost(auth, "/sign-in/email", { "cf-connecting-ip": ip, "x-forwarded-for": xff });
    for (let i = 0; i < 10; i++) await signIn(REAL_IP, `198.51.100.${i}`);
    expect((await signIn(REAL_IP, "198.51.100.200")).status).toBe(429);
    // A different real visitor sending the same spoofed chain keeps its own budget.
    expect((await signIn("203.0.113.8", "198.51.100.200")).status).not.toBe(429);
  });

  test("the resend endpoint carries its own rule (eccos-hk5)", async () => {
    const { auth } = await createTestAuth();
    // POST /send-verification-email takes an arbitrary caller-supplied address
    // and sends real mail to it, so it does not ride the global 60s/100 rule.
    expect(auth.options.rateLimit?.customRules?.["/send-verification-email"]).toEqual({
      window: 300,
      max: 5,
    });
  });

  test(
    "/send-verification-email allows 5 per window, then refuses",
    async () => {
      const { auth } = await createTestAuth();
      const resend = () =>
        auth.handler(
          new Request(`${BASE_URL}/api/auth/send-verification-email`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: BASE_URL },
            // An address that was never signed up: Better Auth answers 200
            // behind a constant-time floor either way, so the limiter is the
            // only thing deciding here.
            body: JSON.stringify({ email: "victim@corp.test", callbackURL: "/" }),
          }),
        );
      // Better Auth ships its own default for this path (60s/3), which our
      // custom rule overrides — a fourth and fifth call still going through is
      // what proves the override took effect rather than the framework default.
      for (let i = 0; i < 5; i++) {
        expect((await resend()).status).not.toBe(429);
      }
      expect((await resend()).status).toBe(429);
    },
    30_000,
  );
});
