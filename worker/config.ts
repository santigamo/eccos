import { parseCoreConfig, type CoreConfig } from "../src/core/config-schema";

let cached: CoreConfig | undefined;

export function getConfig(env: Env): CoreConfig {
  if (!cached) cached = parseCoreConfig(env as unknown as Record<string, string | undefined>);
  return cached;
}

const DO_CONFIG_KEYS = ["META_WABA_ID", "META_PHONE_NUMBER_ID"] as const;
type DoConfigKey = (typeof DO_CONFIG_KEYS)[number];

/** D5: DO storage overrides env seeds for onboarded ids. */
export function overlayDoConfig(
  base: CoreConfig,
  stored: Partial<Record<DoConfigKey, string>>,
): CoreConfig {
  const out = { ...base };
  for (const key of DO_CONFIG_KEYS) {
    const value = stored[key];
    if (value) out[key] = value;
  }
  return out;
}

export async function getEffectiveConfig(
  env: Env,
  stub: { getConfigValue(key: string): string | null | Promise<string | null> },
): Promise<CoreConfig> {
  const base = getConfig(env);
  const stored: Partial<Record<DoConfigKey, string>> = {};
  for (const key of DO_CONFIG_KEYS) {
    const value = await stub.getConfigValue(key);
    if (value) stored[key] = value;
  }
  return overlayDoConfig(base, stored);
}
