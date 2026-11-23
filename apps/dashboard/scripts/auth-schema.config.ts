/**
 * SPIKE (task 0.3): schema generation config with the OAuth provider plugins.
 */
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { jwt, organization, twoFactor } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";

// Lever (spike): replay the committed migrations first, so the CLI emits only the delta.
import { readdirSync, readFileSync } from "node:fs";
const db = new Database(":memory:");
const dir = new URL("../migrations/", import.meta.url).pathname;
for (const f of readdirSync(dir).sort()) {
  if (f.endsWith(".sql") && !process.env.SPIKE_SKIP?.split(",").includes(f)) db.exec(readFileSync(dir + f, "utf8"));
}

export const auth = betterAuth({
  database: db,
  secret: "schema-generation-only-secret-32-chars!!",
  // Finding (spike): the oauth-provider init validates the issuer, so generation fails with
  // "Invalid URL" unless a baseURL is set.
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
  plugins: [
    organization(),
    twoFactor(),
    jwt(),
    mcp({ loginPage: "/signin", consentPage: "/oauth/consent", resource: "https://mcp.example.com/mcp" }),
    cimd({ fetchClientMetadataResource: fetch, metadataProfile: "mcp-2026-07-28" }),
  ],
});
