/**
 * Better Auth CLI config used ONLY to generate the auth D1 schema SQL. Not
 * imported at runtime.
 *
 * It replays the committed migrations/*.sql first, so the CLI emits only what
 * they still lack: the next migration, or nothing when they already match the
 * plugins below. Keep the plugins those of createAuth (src/auth/auth.ts) that
 * add tables or fields. Generate the next migration with:
 *   cd apps/dashboard && bunx --bun auth generate --config scripts/auth-schema.config.ts -y --output migrations/000N_name.sql
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import { oauthAuthorizationServer } from "../src/auth/oauth-provider";
import { stepUpGuard } from "../src/auth/step-up-guard";

const migrations = new URL("../migrations/", import.meta.url);
const database = new Database(":memory:");
for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
  database.exec(readFileSync(new URL(file, migrations), "utf8"));
}

// The OAuth provider validates its issuer and resource as URLs, so generation
// needs both; the values never reach the schema.
const baseURL = "http://localhost:3000";
const authorizationServer = oauthAuthorizationServer({ baseURL, mcpResource: "http://localhost:8788/mcp" });

export const auth = betterAuth({
  database,
  secret: "schema-generation-only-secret-32-chars!!",
  baseURL,
  disabledPaths: authorizationServer.disabledPaths,
  emailAndPassword: { enabled: true },
  plugins: [organization(), twoFactor(), stepUpGuard(), ...authorizationServer.plugins],
});
