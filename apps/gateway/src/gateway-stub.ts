import {
  DO_JURISDICTIONS,
  type DoJurisdiction,
} from "@eccos/core/config-schema";
import type { EccosGateway } from "./gateway";

export const GATEWAY_ROUTING_VERSION = "v1";

export function normalizeWabaId(wabaId: string): string {
  const normalized = wabaId.trim();
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error("Invalid WABA ID for Durable Object routing");
  }
  return normalized;
}

export function gatewayObjectName(wabaId: string, jurisdiction: DoJurisdiction | undefined): string {
  return `${GATEWAY_ROUTING_VERSION}:${jurisdiction ?? "auto"}:waba:${normalizeWabaId(wabaId)}`;
}

/**
 * Single source of truth for resolving the EccosGateway Durable Object stub.
 *
 * Every call site MUST go through `getGatewayStubForWaba` — deriving the id ad hoc
 * would silently ignore `DO_JURISDICTION` and split traffic across two different
 * Durable Objects.
 *
 * CRITICAL — jurisdiction changes do not migrate data: a jurisdiction produces a
 * different `DurableObjectId` for the same name, i.e. a brand-new, EMPTY Durable
 * Object. Set `DO_JURISDICTION` before the deployment holds production data, and
 * never change it afterwards without an explicit data migration plan.
 */

/**
 * Validates the optional `DO_JURISDICTION` variable. Empty/absent means "no
 * jurisdiction" (current behavior: the DO is created wherever the first request
 * lands). Any other value than a supported Cloudflare jurisdiction fails loudly
 * instead of being silently ignored.
 */
export function resolveDoJurisdiction(env: { DO_JURISDICTION?: string }): DoJurisdiction | undefined {
  const raw = env.DO_JURISDICTION?.trim();
  if (!raw) return undefined;
  if ((DO_JURISDICTIONS as readonly string[]).includes(raw)) return raw as DoJurisdiction;
  const supported = DO_JURISDICTIONS.map((j) => `"${j}"`).join(", ");
  throw new Error(
    [
      `Invalid DO_JURISDICTION "${raw}".`,
      `Supported values: ${supported}, or unset for no jurisdiction.`,
      'Note: Cloudflare has no "us" jurisdiction.',
      "WARNING: changing the jurisdiction of an existing deployment creates a new,",
      "empty Durable Object and does NOT migrate data — see docs/deployment.md.",
    ].join(" "),
  );
}

export function getGatewayStubForWaba(env: Env, wabaId: string): DurableObjectStub<EccosGateway> {
  const jurisdiction = resolveDoJurisdiction(env);
  const ns = jurisdiction ? env.ECCOS.jurisdiction(jurisdiction) : env.ECCOS;
  return ns.get(ns.idFromName(gatewayObjectName(wabaId, jurisdiction)));
}
