import type { AccountWabaResource } from "./index";

/**
 * Which provisioning statuses a caller is willing to work with.
 *
 * `"active"` is the rule for the data plane. `"any"` is for the WABA-LEVEL
 * reads and writes — templates, subscriber config — that need only the WABA id
 * and its stored token, and are exactly what an operator prepares on a
 * connected account that is still waiting for its phone number.
 */
export type ScopeMode = "active" | "any";

/**
 * Pick the WABA an account-scoped operation runs against. Pure and shared: the
 * gateway enforces it on every scoped read, the console reuses it for writes.
 */
export function selectWaba(
  accountId: string,
  wabaResources: readonly AccountWabaResource[],
  requestedWabaId?: string,
  rejectUnknown = false,
  mode: ScopeMode = "active",
): AccountWabaResource {
  const requested = requestedWabaId?.trim() || undefined;
  const wabas = [...wabaResources].sort((a, b) => a.wabaId.localeCompare(b.wabaId));
  const requestedIsOwned = requested ? wabas.some((waba) => waba.wabaId === requested) : false;
  if (requested && !requestedIsOwned && rejectUnknown) {
    throw new Error(`WABA "${requested}" is not owned by account "${accountId}"`);
  }
  // Unrequested selection prefers the first ACTIVE WABA rather than the first
  // by id: an account with one active and one pending WABA must not resolve to
  // the pending one just because it sorts first. Falling back to `wabas[0]`
  // when none is active keeps the all-pending account's error wording.
  const defaultWaba = wabas.find((waba) => waba.status === "active") ?? wabas[0];
  const selected = requestedIsOwned ? wabas.find((waba) => waba.wabaId === requested) : defaultWaba;
  if (!selected) throw new Error(`Account "${accountId}" has no registered WABAs`);
  if (mode === "any") return selected;
  // An EXPLICITLY requested pending/failed WABA still throws.
  if (selected.status === "pending") throw new Error(`WABA "${selected.wabaId}" is still provisioning`);
  if (selected.status === "failed") throw new Error(`WABA "${selected.wabaId}" provisioning failed`);
  return selected;
}
