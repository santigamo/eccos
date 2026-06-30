import { z } from "zod";

function clean(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === "string" && v.trim() === "" ? undefined : v;
  }
  return out;
}

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
});
export type CoreConfig = z.infer<typeof coreSchema>;

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

export function graphBaseUrl(cfg: { META_GRAPH_VERSION: string }): string {
  return `https://graph.facebook.com/${cfg.META_GRAPH_VERSION}`;
}
