/**
 * Pure workspace (organization) view helpers.
 *
 * Shared by the shell's workspace control, the failure-state picker, and the
 * server function that feeds them, so "which workspace is this" is answered the
 * same way everywhere. Nothing here is authorization: the server re-derives and
 * re-validates the tenant on every request (see `auth/tenant.ts`), and this
 * module only decides what a signed-in operator is TOLD about their own scope.
 */

import type { Membership } from "../auth/tenant";

/** What a workspace is called on screen, with the fallbacks a name can need. */
export function workspaceLabel(workspace: Membership): string {
  return workspace.name || workspace.slug || workspace.id;
}

/**
 * The square monogram's letter — the console's identity idiom, reused from the
 * sidebar's user tile rather than inventing a second avatar.
 */
export function workspaceInitial(workspace: Membership): string {
  return workspaceLabel(workspace).slice(0, 1).toUpperCase();
}

/**
 * Which membership the shell marks as active.
 *
 * This MIRRORS `requirePermission`'s derivation deliberately, so the console
 * never names a workspace the server would refuse:
 *
 * - a stored active organization is honoured only while it is still a
 *   membership (revoked access resolves to null, exactly as the server's
 *   `not-a-member` refusal);
 * - with nothing stored, a sole membership is not ambiguous and is defaulted
 *   to, as the server does;
 * - with nothing stored and several memberships, there is no answer yet —
 *   the server's `select-organization` state.
 */
export function activeWorkspace(
  workspaces: Membership[],
  activeWorkspaceId: string | null | undefined,
): Membership | null {
  if (activeWorkspaceId) {
    return workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  }
  return workspaces.length === 1 ? (workspaces[0] ?? null) : null;
}

/**
 * Whether there is anything to switch BETWEEN. Most operators live in exactly
 * one workspace forever, and a list of one is clutter, not a choice.
 */
export function hasWorkspaceChoice(workspaces: Membership[]): boolean {
  return workspaces.length > 1;
}
