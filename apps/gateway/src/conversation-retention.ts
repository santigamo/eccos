/** Config key holding the workspace's conversation retention: "forever" or a day count. */
export const CONVERSATION_RETENTION_CONFIG_KEY = "conversation_retention_days";
const KEEP_CONVERSATIONS_FOREVER = "forever";

/** Null means keep forever. An unset or unreadable value counts as forever, the default. */
export function conversationRetentionDays(configValue: string | null): number | null {
  if (configValue === null || configValue === KEEP_CONVERSATIONS_FOREVER) return null;
  const days = Number(configValue);
  return Number.isInteger(days) && days > 0 ? days : null;
}

/** The stored form of a retention setting; the inverse of `conversationRetentionDays`. */
export function conversationRetentionConfigValue(days: number | null): string {
  return days === null ? KEEP_CONVERSATIONS_FOREVER : String(days);
}
