/** Config-table keys that are secrets/raw credentials and must never leave the
 * DO — filtered out of `exportData()` (and mirrored by the RPC layer's own
 * filter). Anything else in the `config` table is considered safe connection
 * metadata (WABA/phone ids, callback URL, display phone, connected-at). The
 * account-scoped flow keeps these keys filtered defensively if an older object
 * or a direct internal write contains them. */
export const PRIVATE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "META_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_WEBHOOK_VERIFY_TOKEN",
  "ECCOS_API_KEY",
  "SUBSCRIBER_SECRET",
]);

export function isPublicConfigKey(key: string): boolean {
  return !PRIVATE_CONFIG_KEYS.has(key) && !key.startsWith("__");
}
