/** `RESELLER_USER_IDS`: comma-separated user ids whose new workspaces open without a subscription (they are invoiced separately). */
export function isReseller(userId: string, configured: string | undefined): boolean {
  if (!configured) return false;
  return configured
    .split(",")
    .map((id) => id.trim())
    .some((id) => id !== "" && id === userId);
}
