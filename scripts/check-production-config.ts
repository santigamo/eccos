#!/usr/bin/env bun
// Local preflight for the production deploy helpers (docs/deployment.md#production-config).
// Reads the gitignored wrangler.production.jsonc files and refuses obviously wrong values
// before anything is built or uploaded. It cannot see Cloudflare state, and raw
// `wrangler deploy` bypasses it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { unstable_readConfig as readConfig } from "wrangler";

const root = join(import.meta.dir, "..");
const errors: string[] = [];

function read(app: string, file: string) {
  const path = join(root, "apps", app, file);
  if (!existsSync(path)) {
    errors.push(`apps/${app}/${file} is missing`);
    return null;
  }
  return readConfig({ config: path });
}

const gateway = read("gateway", "wrangler.production.jsonc");
const dashboard = read("dashboard", "wrangler.production.jsonc");
const gatewayTemplate = read("gateway", "wrangler.jsonc");

if (gateway) {
  const url = String(gateway.vars.GATEWAY_PUBLIC_URL ?? "");
  if (!url.startsWith("https://")) errors.push(`gateway GATEWAY_PUBLIC_URL must be an https origin, got "${url}"`);
}

if (dashboard) {
  const authUrl = String(dashboard.vars.BETTER_AUTH_URL ?? "");
  if (!authUrl.startsWith("https://")) errors.push(`dashboard BETTER_AUTH_URL must be an https origin, got "${authUrl}"`);
  const id = dashboard.d1_databases.find((db) => db.binding === "DB")?.database_id ?? "";
  if (!id || /^[0-]+$/.test(id)) errors.push("dashboard DB database_id is missing or the template placeholder");
}

if (gateway && dashboard && gateway.vars.META_GRAPH_VERSION !== dashboard.vars.META_GRAPH_VERSION) {
  errors.push(
    `META_GRAPH_VERSION differs: gateway ${gateway.vars.META_GRAPH_VERSION}, dashboard ${dashboard.vars.META_GRAPH_VERSION}`,
  );
}

// Durable Object state and media live behind these; template drift must be deliberate.
if (gateway && gatewayTemplate) {
  for (const key of ["durable_objects", "migrations", "r2_buckets"] as const) {
    if (JSON.stringify(gateway[key]) !== JSON.stringify(gatewayTemplate[key])) {
      errors.push(`gateway ${key} differs between wrangler.jsonc and wrangler.production.jsonc`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  console.error("See docs/deployment.md#production-config");
  process.exit(1);
}
