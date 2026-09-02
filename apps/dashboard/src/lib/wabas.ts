/**
 * Pure WABA (WhatsApp Business Account) view helpers.
 *
 * The sibling of `lib/workspaces.ts`, for the second crumb of the masthead
 * breadcrumb. Nothing here is authorization: which WABA a request may read is
 * re-derived and re-validated server-side on every call (`resolveScope` in
 * `server/gateway.ts`, which owns the account → WABA registry). This module
 * only decides what an operator is TOLD about the scope they are already in.
 *
 * The reason it exists at all: a WABA has no name. The contract carries an id,
 * a provisioning status, a coexistence record and a list of phone numbers —
 * and the sixteen-digit id is the one field a person cannot recognise. So the
 * console leads with the number the operator dialled, and keeps the id as the
 * machine-voice sub-line that identifies the account exactly.
 */

import type { AccountWabaResource } from "@eccos/gateway-contract";

/**
 * A WABA id, shortened for a place where the whole thing does not fit.
 *
 * Head and tail, never a plain prefix: two WABAs on the same account differ in
 * their last digits far more often than in their first, so a prefix-only
 * ellipsis can render two different accounts identically.
 */
export function shortWabaId(wabaId: string): string {
  return wabaId.length > 12 ? `${wabaId.slice(0, 4)}…${wabaId.slice(-4)}` : wabaId;
}

/**
 * What a WABA is called on screen.
 *
 * `displayPhoneNumber` is the most human field the contract has — it is what
 * the customer's clients see and what the operator recognises. A WABA with no
 * number yet (Embedded Signup v4 lets a customer finish having entered none)
 * has nothing better than its id, and falls back to the shortened form.
 */
export function wabaLabel(waba: AccountWabaResource): string {
  const numbered = waba.phones.find((phone) => phone.displayPhoneNumber.trim() !== "");
  return numbered ? numbered.displayPhoneNumber.trim() : shortWabaId(waba.wabaId);
}

/**
 * The square monogram's character — the console's identity idiom, reused from
 * the sidebar's user tile rather than inventing a second avatar. For a phone
 * number that is the `+` of E.164, which is exactly what the row is.
 */
export function wabaInitial(waba: AccountWabaResource): string {
  return wabaLabel(waba).slice(0, 1).toUpperCase();
}

/**
 * The one word of state a WABA row carries, in the vocabulary `StatusTag`
 * already maps (`src/ui.tsx`): `pending` / `failed` are provisioning states and
 * outrank everything, `not_coexistence` is the one coexistence outcome an
 * operator has to be told about (eccos-vss — the number works, its WhatsApp
 * Business app history was never synchronised and never will be), and anything
 * else is a plain `active`.
 *
 * Provisioning first because it is the harder fact: a `pending` WABA cannot be
 * scoped to at all (`resolveScopeFromAccount` throws on it), so an operator
 * about to pick one has to see that before anything subtler.
 */
export function wabaState(waba: AccountWabaResource): string {
  if (waba.status !== "active") return waba.status;
  if (waba.coexistence.status === "not_coexistence") return "not_coexistence";
  return "active";
}

/**
 * Which WABA the breadcrumb marks as current.
 *
 * Mirrors `activeWorkspace`: a selection is honoured only while it is still one
 * of the account's WABAs, so a stale `?wabaId=` in a bookmarked URL never makes
 * the masthead name an account this operator does not own. The server already
 * refuses that request; this keeps the console from claiming otherwise.
 */
export function activeWaba(
  wabas: AccountWabaResource[],
  selectedWabaId: string | null | undefined,
): AccountWabaResource | null {
  if (selectedWabaId) {
    return wabas.find((waba) => waba.wabaId === selectedWabaId) ?? null;
  }
  return wabas.length === 1 ? (wabas[0] ?? null) : null;
}

/**
 * Whether there is anything to switch BETWEEN. One WABA is the normal shape of
 * an account, and a dropdown holding a single row is clutter, not a choice —
 * the crumb still names it, it just stops being a button.
 */
export function hasWabaChoice(wabas: AccountWabaResource[]): boolean {
  return wabas.length > 1;
}
