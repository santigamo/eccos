/**
 * Parity guard: `roleAllows` evaluates permissions locally instead of calling
 * Better Auth's `hasPermission`. On a real instance, every role (single,
 * comma-separated, unknown) x every gateway action must agree, so drift on a
 * Better Auth upgrade fails CI.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";
import { roleAllows } from "../src/auth/identity";
import { GATEWAY_ACTIONS, roles } from "../src/auth/permissions";

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
  const headers = () => new Request(`${BASE_URL}/`, { headers: { cookie } }).headers;
  const org = (await auth.api.createOrganization({
    body: { name: "Acme", slug: crypto.randomUUID() },
    headers: headers(),
  })) as { id: string };
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: headers() });
  const setRole = (role: string) =>
    db.query("UPDATE member SET role = ? WHERE organizationId = ?").run(role, org.id);
  return { auth, headers, setRole };
}

const roleStrings = [
  ...Object.keys(roles),
  "viewer,operator",
  "operator,admin",
  "viewer,owner",
  "owner,admin",
  "unknown",
  "viewer,unknown",
  "unknown,operator",
  "",
  "toString",
  "constructor",
  "__proto__",
];

describe("roleAllows parity with Better Auth hasPermission", () => {
  test("every role string x every gateway action agrees", async () => {
    const { auth, headers, setRole } = await setup();
    const mismatches: string[] = [];
    for (const role of roleStrings) {
      setRole(role);
      for (const action of GATEWAY_ACTIONS) {
        let expected: boolean;
        try {
          const result = (await auth.api.hasPermission({
            headers: headers(),
            body: { permissions: { gateway: [action] } },
          })) as { success?: boolean };
          expected = result.success === true;
        } catch {
          expected = false;
        }
        if (roleAllows(role, action) !== expected) mismatches.push(`${JSON.stringify(role)}/${action}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
