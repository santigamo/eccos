import type { CoreConfig } from "@eccos/core/config-schema";

export type AppConfig = Pick<
  CoreConfig,
  "META_GRAPH_VERSION" | "META_APP_SECRET" | "META_WEBHOOK_VERIFY_TOKEN" | "META_APP_ID" | "META_ES_CONFIG_ID"
>;

export type TenantConfig = Pick<
  CoreConfig,
  | "META_GRAPH_VERSION"
  | "META_ACCESS_TOKEN"
  | "META_PHONE_NUMBER_ID"
  | "META_WABA_ID"
  | "META_APP_SECRET"
  | "META_WEBHOOK_VERIFY_TOKEN"
>;

export interface TenantCredentials {
  wabaId: string;
  phoneNumberId: string;
  metaAccessToken: string;
}

export type TenantMode = "legacy" | "shadow" | "enforced";

export function tenantMode(env: { ECCOS_MULTI_TENANT?: string }): TenantMode {
  switch (env.ECCOS_MULTI_TENANT?.trim().toLowerCase()) {
    case "shadow":
      return "shadow";
    case "true":
      return "enforced";
    default:
      return "legacy";
  }
}

export function isMultiTenantEnabled(env: { ECCOS_MULTI_TENANT?: string }): boolean {
  return tenantMode(env) === "enforced";
}

export function isTenantControlPlaneEnabled(env: { ECCOS_MULTI_TENANT?: string }): boolean {
  return tenantMode(env) !== "legacy";
}

export function getAppConfig(env: Env): AppConfig {
  const values = env as unknown as Record<string, string | undefined>;
  const required = (key: "META_APP_SECRET" | "META_WEBHOOK_VERIFY_TOKEN"): string => {
    const value = values[key]?.trim();
    if (!value) throw new Error(`Invalid Eccos configuration: ${key} is required`);
    return value;
  };
  return {
    META_GRAPH_VERSION: values.META_GRAPH_VERSION?.trim() || "v24.0",
    META_APP_SECRET: required("META_APP_SECRET"),
    META_WEBHOOK_VERIFY_TOKEN: required("META_WEBHOOK_VERIFY_TOKEN"),
    ...(values.META_APP_ID?.trim() ? { META_APP_ID: values.META_APP_ID.trim() } : {}),
    ...(values.META_ES_CONFIG_ID?.trim() ? { META_ES_CONFIG_ID: values.META_ES_CONFIG_ID.trim() } : {}),
  };
}

export function tenantConfig(app: AppConfig, credentials: TenantCredentials): TenantConfig {
  return {
    META_GRAPH_VERSION: app.META_GRAPH_VERSION,
    META_ACCESS_TOKEN: credentials.metaAccessToken,
    META_PHONE_NUMBER_ID: credentials.phoneNumberId,
    META_WABA_ID: credentials.wabaId,
    META_APP_SECRET: app.META_APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: app.META_WEBHOOK_VERIFY_TOKEN,
  };
}
