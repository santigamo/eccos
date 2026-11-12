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

// Billing is two switches that only make sense together: Creem on the dashboard and
// closed-by-default on the gateway. CREEM_API_KEY is a secret this script cannot see,
// so the dashboard's CREEM_PRODUCT_ID var stands for it.
if (gateway && dashboard) {
  const billing = Boolean(dashboard.vars.CREEM_PRODUCT_ID);
  const closed = gateway.vars.CONNECT_POLICY_DEFAULT === "closed";
  if (billing !== closed) {
    errors.push(
      billing
        ? "dashboard CREEM_PRODUCT_ID is set but gateway CONNECT_POLICY_DEFAULT is not \"closed\""
        : "gateway CONNECT_POLICY_DEFAULT is \"closed\" but dashboard CREEM_PRODUCT_ID is not set",
    );
  }
  if (billing && (dashboard.triggers.crons ?? []).length === 0) {
    errors.push("dashboard billing is on but triggers.crons is empty: the daily reconcile would never run");
  }
}

// Durable Object state and media live behind these; template drift must be deliberate.
if (gateway && gatewayTemplate) {
  for (const key of ["durable_objects", "migrations", "r2_buckets", "ratelimits"] as const) {
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
