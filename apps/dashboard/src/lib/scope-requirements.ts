import type { DashboardState } from "../server/gateway";

/**
 * What a route needs from the tenant's scope before it is a destination.
 *
 * Two levels, because the console has two kinds of page and used to have one
 * flag for both:
 *
 * - `"number"` — the page reads the per-WABA data plane (its Durable Object).
 *   Without an active WABA there is no data plane at all, so the page has
 *   nothing to render and its loader would throw.
 * - `"waba"` — the page reads WABA-level resources: the template list needs
 *   only the WABA id and its stored Meta token, and the subscriber config is
 *   exactly what an operator prepares BEFORE any traffic arrives. Both work on
 *   a WABA that is connected but still awaiting its phone number.
 * - `"none"` — /numbers is the way out of every locked state,
 *   /workspaces/new is about the workspace rather than its numbers, and
 *   /settings is a second way out: its pasted-token panel (eccos-up9) is how
 *   Meta's Cloud API test number gets attached, and that number's whole point
 *   is that the account has none yet. Gating the page on a WABA locked the one
 *   form that creates one. The WABA-level sections of that page degrade to a
 *   note instead — see `routes/settings.tsx`.
 *
 * One module, so the sidebar and the root redirect cannot drift on which pages
 * exist before a number. Type-only import, so it stays exercisable under plain
 * `bun test`.
 */
export type ScopeRequirement = "none" | "waba" | "number";

/**
 * The map is exhaustive on purpose for the routes it names, and defaults the
 * rest to `"number"` — the old behaviour for anything unlisted (e.g.
 * /invitations), which bounced to /numbers.
 */
export const SCOPE_REQUIREMENTS: Record<string, ScopeRequirement> = {
  "/numbers": "none",
  "/workspaces/new": "none",
  "/templates": "waba",
  "/settings": "none",
  "/": "number",
  "/deliveries": "number",
  "/inbound": "number",
  "/outbound": "number",
};

const DEFAULT_REQUIREMENT: ScopeRequirement = "number";

export function requirementFor(pathname: string): ScopeRequirement {
  return SCOPE_REQUIREMENTS[pathname] ?? DEFAULT_REQUIREMENT;
}

/** An active WABA with a number behind it: the data plane is readable. */
export function hasNumberScope(state: DashboardState): boolean {
  return state.stage === "ready";
}

/**
 * A WABA exists and is the account's, whatever its provisioning status.
 *
 * With ZERO WABAs this is false and the `"waba"` pages stay locked, correctly:
 * subscriber config has no home and there is no WABA whose templates to list.
 */
export function hasWabaScope(state: DashboardState): boolean {
  if (state.stage === "ready") return true;
  return state.stage === "account-ready" && state.resources.wabas.length > 0;
}

export function requirementSatisfied(pathname: string, state: DashboardState): boolean {
  switch (requirementFor(pathname)) {
    case "none":
      return true;
    case "waba":
      return hasWabaScope(state);
    default:
      return hasNumberScope(state);
  }
}
