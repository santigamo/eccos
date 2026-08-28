import { z } from "zod";

function clean(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === "string" && v.trim() === "" ? undefined : v;
  }
  return out;
}

/**
 * Durable Object jurisdictions Cloudflare actually supports. Note there is no
 * "us" jurisdiction on Cloudflare — data-residency pinning is only offered for
 * the EU and FedRAMP environments.
 */
export const DO_JURISDICTIONS = ["eu", "fedramp", "fedramp-high"] as const;
export type DoJurisdiction = (typeof DO_JURISDICTIONS)[number];

/** Single-tenant env config (Bun self-host target, `src/`). The Workers target
 * is unconditionally account-scoped and resolves per-WABA credentials from the
 * control plane instead of global env secrets. */
export const coreSchema = z.object({
  META_GRAPH_VERSION: z.string().min(1).default("v24.0"),
  META_ACCESS_TOKEN: z.string().min(1),
  META_PHONE_NUMBER_ID: z.string().min(1),
  META_WABA_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  ECCOS_API_KEY: z.string().min(1),
  SUBSCRIBER_WEBHOOK_URL: z.string().url().optional(),
  SUBSCRIBER_SECRET: z.string().min(1).optional(),
  FORWARD_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  META_APP_ID: z.string().min(1).optional(),
  META_ES_CONFIG_ID: z.string().min(1).optional(),
  /**
   * Optional Durable Object jurisdiction (Workers). Empty/absent keeps
   * the current behavior: the DO is created wherever the first request lands.
   * CRITICAL: changing this after data exists points the gateway at a NEW, EMPTY
   * Durable Object — existing data is NOT migrated. Set it before going live.
   */
  DO_JURISDICTION: z.enum(DO_JURISDICTIONS).optional(),
});
export type CoreConfig = z.infer<typeof coreSchema>;

/**
 * The Meta Cloud API config fields that the shared helpers (`sendMessage`,
 * `listTemplates`) read. A structural subset of `CoreConfig` plus a
 * `META_GRAPH_VERSION` default — so a multi-tenant app config that resolves a
 * default WABA/phone/API key per request (rather than from env) satisfies it
 * without carrying the single-tenant `CoreConfig` fields.
 */
export type MetaAppConfig = {
  META_GRAPH_VERSION?: string;
  META_ACCESS_TOKEN: string;
  META_PHONE_NUMBER_ID?: string;
  META_WABA_ID?: string;
};

export function parseCoreConfig(env: Record<string, string | undefined>): CoreConfig {
  const parsed = coreSchema.safeParse(clean(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid Eccos configuration:\n${issues}`);
  }
  return parsed.data;
}

function metaGraphVersion(cfg: { META_GRAPH_VERSION?: string }): string {
  return cfg.META_GRAPH_VERSION ?? "v24.0";
}

export function graphBaseUrl(cfg: { META_GRAPH_VERSION?: string }): string {
  return `https://graph.facebook.com/${metaGraphVersion(cfg)}`;
}
