/** `RESELLER_USER_IDS`: comma-separated user ids whose new workspaces open without a subscription (they are invoiced separately). */
export function isReseller(userId: string, configured: string | undefined): boolean {
  return userId !== "" && (configured ?? "").split(",").some((id) => id.trim() === userId);
}
