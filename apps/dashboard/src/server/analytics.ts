import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getAuthForRequest } from "../auth/request-auth";
import { resolveSession } from "../auth/session";
import type { AnalyticsConfig } from "../lib/analytics";

interface AnalyticsEnv {
  ANALYTICS_SCRIPT_URL?: string;
  ANALYTICS_WEBSITE_ID?: string;
  ANALYTICS_DOMAINS?: string;
  /** Wrangler secret: comma-separated user ids that never load the tracker. */
  ANALYTICS_EXCLUDE_USER_IDS?: string;
}

/**
 * The tracker config for this request, or null when analytics is off (the
 * self-host default) or the signed-in user is excluded. Ungated on purpose:
 * sign-in and sign-up are part of the funnel.
 */
export const getAnalyticsConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<AnalyticsConfig | null> => {
    const vars = env as AnalyticsEnv;
    const scriptUrl = vars.ANALYTICS_SCRIPT_URL?.trim();
    const websiteId = vars.ANALYTICS_WEBSITE_ID?.trim();
    if (!scriptUrl || !websiteId) return null;

    const session = await resolveSession(getAuthForRequest(getRequest(), env), getRequest());
    const excluded = vars.ANALYTICS_EXCLUDE_USER_IDS?.split(",").map((id) => id.trim()) ?? [];
    if (session && excluded.includes(session.userId)) return null;

    return {
      scriptUrl,
      websiteId,
      domains: vars.ANALYTICS_DOMAINS?.trim() || "app.eccos.chat",
      userId: session ? await hashUserId(session.userId) : null,
    };
  },
);

/** First 16 hex chars of SHA-256("eccos:" + id): the raw id never leaves the Worker. */
export async function hashUserId(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`eccos:${userId}`));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
