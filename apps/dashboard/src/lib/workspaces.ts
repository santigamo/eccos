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

/** What a workspace is called on screen, with the fallback a name can need. */
export function workspaceLabel(workspace: Membership): string {
  return workspace.name || workspace.id;
}

/**
 * A workspace id, shortened to the length a person can compare at a glance.
 *
 * Better Auth organization ids are random, so a prefix is as distinguishing as
 * any other slice — unlike a WABA id (see `shortWabaId`, which takes head AND
 * tail because those ids share a long common prefix).
 */
export function workspaceShortId(workspace: Membership): string {
  return workspace.id.slice(0, 6);
}

/**
 * The labels that appear more than once in ONE user's own membership list.
 *
 * Workspace names are not unique — deliberately: the slug that used to force
 * global uniqueness was a cross-tenant existence oracle (any two customers who
 * both named a workspace "Citta" collided, and the collision was reported to
 * the browser), so it became an opaque server-minted value and names became
 * free. That correctness has one UI consequence: a person who belongs to two
 * workspaces genuinely called the same thing needs something to tell the rows
 * apart.
 *
 * The answer is scoped to this user's OWN list. Only rows whose label repeats
 * inside it get a short-id sub-line; every other row stays a name alone, and no
 * row ever displays anything derived from a workspace the user cannot see.
 * A permanent sub-line on every row would be noise for the ~100% of operators
 * who have no ambiguity to resolve.
 */
export function duplicateWorkspaceLabels(workspaces: Membership[]): Set<string> {
  const counts = new Map<string, number>();
  for (const workspace of workspaces) {
    const label = workspaceLabel(workspace);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [label, count] of counts) {
    if (count > 1) duplicates.add(label);
  }
  return duplicates;
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
