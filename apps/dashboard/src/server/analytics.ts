/**
 * Analytics configuration for the browser (eccos-mlq0.2).
 *
 * This is the ONE seam that turns Worker vars into something the document can
 * render, and it is a server function rather than loader code for two reasons:
 * `env` is a server binding, and the user id must be hashed before it leaves
 * the Worker. The loader calls it once per page load and hands the result to
 * `RootDocument`.
 *
 * IT IS DELIBERATELY UNGATED BY PERMISSIONS. The sign-in and sign-up screens
 * are where two of the funnel events happen, so an anonymous visitor must
 * receive the tracker config too. What that exposes is the public script URL
 * and website id — the same values the landing serves as plain HTML — plus, for
 * a signed-in visitor, a salted hash. No raw user id, email, organization or
 * tenant identifier is ever part of the response.
 *
 * FAIL CLOSED, NEVER LOUD. Any identity lookup that throws (D1 hiccup, an
 * organization plugin edge) degrades to `user: null`: a pageview is worth less
 * than the console. An excluded user is different — that returns null for the
 * whole config, so their browser loads no tracker at all.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { createAuth, type Auth } from "../auth/auth";
import { authConfigFromEnv } from "../auth/config";
import { resolveSession } from "../auth/session";
import { resolveMemberships } from "../auth/tenant";
import {
  analyticsConfigFromEnv,
  analyticsUserId,
  isAnalyticsExcluded,
  type AnalyticsClientConfig,
} from "../lib/analytics";

/**
 * The current member's role. Better Auth's organization plugin owns this
 * vocabulary (owner/admin/member), which is what makes it safe to ship: it is a
 * role name, not a permission decision, and the console never authorizes on it.
 * A session with no active organization legitimately has none.
 */
async function activeRole(auth: Auth, headers: Headers): Promise<string | null> {
  try {
    const result = (await auth.api.getActiveMemberRole({ headers })) as {
      role?: unknown;
    } | null;
    return typeof result?.role === "string" ? result.role : null;
  } catch {
    return null;
  }
}

export const getAnalyticsContext = createServerFn({ method: "GET" }).handler(
  async (): Promise<AnalyticsClientConfig | null> => {
    const config = analyticsConfigFromEnv(env);
    if (!config) return null;

    const base = {
      scriptUrl: config.scriptUrl,
      websiteId: config.websiteId,
      domains: config.domains,
    };

    const auth = createAuth(authConfigFromEnv(env));
    const request = getRequest();
    const session = await resolveSession(auth, request);
    if (!session) return { ...base, user: null };
    if (isAnalyticsExcluded(config, session.userId)) return null;

    const [id, role, memberships] = await Promise.all([
      analyticsUserId(session.userId),
      activeRole(auth, request.headers),
      // The identity lookup is the one read an analytics payload cannot do
      // without (it is the `hasOrg` trait); a failure drops the trait, not the
      // page.
      resolveMemberships(auth, request.headers).catch(() => []),
    ]);

    return {
      ...base,
      user: { id, role, hasOrg: memberships.length > 0 },
    };
  },
);
