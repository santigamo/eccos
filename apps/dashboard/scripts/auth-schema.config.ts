/**
 * Better Auth CLI config used ONLY to generate the auth D1 schema SQL
 * (migrations/0001_better_auth_schema.sql). Not imported at runtime.
 *
 * Generate with:
 *   cd apps/dashboard && bunx --bun auth generate --config scripts/auth-schema.config.ts -y
 */
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";

export const auth = betterAuth({
  database: new Database(":memory:"),
  secret: "schema-generation-only-secret-32-chars!!",
  emailAndPassword: { enabled: true },
  plugins: [organization(), twoFactor()],
});
