/**
 * Umami's document tags and the identify call (eccos-mlq0.2).
 *
 * `AnalyticsScripts` renders nothing when the Worker has no analytics config —
 * that is the whole opt-in: a self-hosted console ships no tracker, no global
 * hook and no `umami` object. The decision is a plain null check so it can be
 * rendered and asserted without a browser (`tests/analytics.test.tsx`).
 *
 * The tags must stay OUT of the route `head()`. That function is static on
 * purpose: an unfurler only ever sees the sign-in shell, and loader data must
 * not be able to leak a workspace name through a `<meta>` tag. Analytics
 * config is loader data, so it belongs in the document body/head that the
 * loader actually rendered.
 *
 * Umami already tracks SPA navigations (the script wraps `history.pushState`),
 * so there is deliberately no second pageview call here. The only client work
 * is `identify`, which has to wait for the deferred script to exist.
 */

import { useEffect } from "react";
import {
  ANALYTICS_BEFORE_SEND,
  analyticsBootstrapScript,
  whenUmamiReady,
  type AnalyticsClientConfig,
  type AnalyticsIdentity,
} from "../lib/analytics";

export function AnalyticsScripts({
  analytics,
}: {
  analytics: AnalyticsClientConfig | null;
}) {
  if (!analytics) return null;
  return (
    <>
      {/* Runs while the document is parsed; the tracker is deferred, so the
          opt-out flag and the before-send hook are in place first. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the string is built from module constants in `lib/analytics.ts`; no request, session or user value reaches it. */}
      <script dangerouslySetInnerHTML={{ __html: analyticsBootstrapScript() }} />
      <script
        defer
        src={analytics.scriptUrl}
        data-website-id={analytics.websiteId}
        data-domains={analytics.domains}
        data-do-not-track="true"
        data-before-send={ANALYTICS_BEFORE_SEND}
      />
    </>
  );
}

/**
 * One identify per load/session change. The tracker is deferred, so the call
 * waits for `window.umami` instead of assuming hydration order; a browser that
 * never loads the script (blocker, `?nostats`) resolves to nothing and the
 * effect ends silently.
 */
export function AnalyticsIdentify({ user }: { user: AnalyticsIdentity | null }) {
  const id = user?.id ?? null;
  const role = user?.role ?? null;
  const hasOrg = user?.hasOrg ?? false;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void whenUmamiReady().then((umami) => {
      if (cancelled || !umami) return;
      try {
        umami.identify(id, { role, hasOrg });
      } catch {
        // Telemetry never breaks the session it is measuring.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, role, hasOrg]);

  return null;
}
