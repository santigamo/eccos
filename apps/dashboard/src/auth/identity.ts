/**
 * Request-scoped membership resolution (contract §1/§5).
 *
 * ONE joined query (member JOIN organization) keyed on the verified session
 * user id, single-flighted per Request like request-memo.ts: a WeakMap keyed by
 * the Request's Headers, so nothing survives the request. Roles stay
 * server-side; only id/name reach callers that build the public list.
 */

import type { Auth } from "./auth";
import { getSessionOnce } from "./request-memo";
import { UnauthorizedError } from "./session";
import { roles, type GatewayAction } from "./permissions";
import { timed } from "../server/timing";

export interface MembershipRole {
  id: string;
  name: string;
  /** Better Auth role string; may hold several comma-separated roles. */
  role: string;
}

interface MemberRow {
  role?: unknown;
  organization?: { id?: unknown; name?: unknown } | null;
}

const byRequest = new WeakMap<Headers, Promise<MembershipRole[]>>();

/** Memberships of the session user, with roles, at most once per Request. */
export function getMembershipsOnce(auth: Auth, headers: Headers): Promise<MembershipRole[]> {
  const cached = byRequest.get(headers);
  if (cached) return cached;

  const resolution = (async () => {
    try {
      const session = await getSessionOnce(auth, headers);
      const userId = session?.session && session.user?.id;
      if (!userId) throw new UnauthorizedError();
      const { adapter } = await auth.$context;
      const rows = (await timed(headers, "auth-memberships", () =>
        adapter.findMany({
          model: "member",
          where: [{ field: "userId", value: userId }],
          join: { organization: true },
        }),
      )) as MemberRow[];
      return rows
        .filter((row) => typeof row.organization?.id === "string")
        .map((row) => ({
          id: String(row.organization?.id),
          name: String(row.organization?.name ?? ""),
          role: String(row.role ?? ""),
        }));
    } catch (err) {
      byRequest.delete(headers);
      throw err;
    }
  })();

  byRequest.set(headers, resolution);
  return resolution;
}

/**
 * Same semantics as Better Auth's `hasPermission`: a comma-separated role
 * string grants the action if ANY role does; unknown roles grant nothing.
 */
export function roleAllows(role: string, action: GatewayAction): boolean {
  return role.split(",").some((name) => {
    if (!Object.hasOwn(roles, name)) return false;
    return roles[name as keyof typeof roles].authorize({ gateway: [action] }).success === true;
  });
}
