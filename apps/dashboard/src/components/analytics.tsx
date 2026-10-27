import { useEffect } from "react";
import {
  analyticsBootstrapScript,
  BEFORE_SEND_HOOK,
  whenUmamiReady,
  type AnalyticsConfig,
} from "../lib/analytics";

/** Null config renders nothing: no tracker, no hook. Pageviews are Umami's own. */
export function AnalyticsScripts({ analytics }: { analytics: AnalyticsConfig | null }) {
  if (!analytics) return null;
  return (
    <>
      {/* Server and client bundles serialize the hook differently (minified); it already ran, so the mismatch is harmless. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: built from module code only; no request or user value reaches it. */}
      <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: analyticsBootstrapScript() }} />
      <script
        defer
        src={analytics.scriptUrl}
        data-website-id={analytics.websiteId}
        data-domains={analytics.domains}
        data-do-not-track="true"
        data-before-send={BEFORE_SEND_HOOK}
      />
    </>
  );
}

export function AnalyticsIdentify({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void whenUmamiReady().then((umami) => {
      if (cancelled || !umami) return;
      try {
        umami.identify(userId);
      } catch {}
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return null;
}
