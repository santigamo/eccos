import { useCallback, useEffect, useRef, useState } from "react";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../reui/frame";
import {
  CONNECT_RETURN_PATH,
  exchangeConnectCode,
  getEmbeddedSignupConfig,
  recordConnectSessionEvent,
  startConnect,
} from "../../server/gateway";
import { loadFacebookSdk } from "../../lib/facebook-sdk";
import {
  type ConnectPath,
  loginOptions,
  parseSessionEvent,
} from "../../lib/embedded-signup";
import { failureCopy } from "../../lib/failure";
import { AUTH_ERROR_BANNER_CLASS } from "../auth/auth-page";
import { cn } from "@/lib/utils";

/**
 * The two ways a number reaches WhatsApp, as the customer has to understand
 * them BEFORE Meta's popup opens.
 *
 * WHY THIS IS A FORK AND NOT A BUTTON. `featureType` rides in `FB.login`'s
 * `extras` (see `lib/embedded-signup.ts`), so it is fixed the instant the popup
 * is spawned. There is no screen inside Meta's flow that asks this, and no way
 * to defer it. The choice is therefore structural.
 *
 * AND THE FORK EXISTS TO PREVENT ONE MISTAKE, not to offer variety: taking
 * `new-number` with a number that is currently live on the WhatsApp Business
 * app TAKES IT OFF THE APP. That is destructive to a working setup and it is
 * not obvious from anything Meta shows, which is why the consequence is on the
 * card rather than in a doc.
 *
 * `caution` is the register the design contract gives this (Inter, 11px,
 * uppercase, tracking-wider — docs/DASHBOARD-DESIGN.md), and it says what the
 * path costs, never how reliable we think it is.
 */
const CONNECT_PATHS: ReadonlyArray<{
  path: ConnectPath;
  title: string;
  detail: string;
  caution: string;
}> = [
  {
    path: "business-app",
    title: "Keep the number on the WhatsApp Business app",
    detail:
      "You keep answering from the app. Meta syncs contacts and message history across both.",
    caution: "Syncs run once · 20 messages/second cap",
  },
  {
    path: "new-number",
    title: "Bring a number to the Cloud API",
    detail:
      "For a number that is not on WhatsApp today. Meta verifies it by SMS or call.",
    caution: "Removes the number from the WhatsApp Business app",
  },
];

/**
 * Shown when the customer picks the WhatsApp Business app path and the SDK is
 * not available. It is deliberately a DEAD END rather than a fallback.
 *
 * The server-side redirect cannot serve coexistence — Meta ignores `extras` on
 * `dialog/oauth` (proved 2026-09-01) and the flow requires session logging,
 * which only the SDK has. So falling back here would silently run the OTHER
 * onboarding: the customer asked to keep their number on the app and would get
 * the flow that takes it off. Failing loudly is the only safe answer.
 */
const SDK_REQUIRED_MESSAGE =
  "Connecting a number that is already on the WhatsApp Business app needs Meta's script, which did not load. Check for a blocker or an extension and try again. Do not use the other option: it would take the number off the app.";

/**
 * Start Meta Embedded Signup. Rendered as the empty state of /numbers on first
 * run and, later, from the same page when the operator adds another number:
 * connecting a number is a recurring operation, not a first-run ritual, so it
 * has one surface rather than a wizard that only exists once.
 *
 * ── TWO PATHS, ONE BUTTON ───────────────────────────────────────────────────
 * Preferred is Meta's JavaScript SDK: `FB.login()` opens the flow in a popup and
 * returns an exchangeable code, and a `message` listener captures **session
 * logging** — the screen a customer abandoned on and the error code they
 * reported. Meta's coexistence requirements list that listener as a "must", and
 * it is the only source of that information.
 *
 * The fallback is the original server-side redirect: a full navigation to the
 * gateway's `/connect`, which owns the Meta callback and hands the operator back
 * here (eccos-5z9). It is used whenever the SDK is not configured or does not
 * load, and it stays the only path a self-hoster without a console has. Neither
 * path is a replacement for the other.
 *
 * The authorization code never buys anything in the browser: it is posted
 * straight to a session-authenticated server function, which forwards it over
 * the private gateway binding. No account API key exists on this page.
 */
export function ConnectNumberPanel({ heading }: { heading: string }) {
  /** The path whose flow is opening, or null. Also disables the other card. */
  const [starting, setStarting] = useState<ConnectPath | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The OAuth state for the popup currently open. Held in a ref, not state,
   * because the SDK callbacks fire outside React's render cycle and must see
   * the value written just before `FB.login` was called.
   */
  const pendingState = useRef<string | null>(null);

  /**
   * Session logging (Meta's `message` listener).
   *
   * Mounted for the life of the panel rather than only while a popup is open:
   * Meta posts the abandonment event as the popup closes, and a listener that
   * is torn down on close races it. `parseSessionEvent` drops anything that is
   * not a genuine Embedded Signup message from a facebook.com origin, so a
   * permanently mounted listener is not a permanently open door.
   */
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const parsed = parseSessionEvent(event.origin, event.data);
      if (!parsed) return;
      // Telemetry must never break the flow the operator is in the middle of.
      void recordConnectSessionEvent({ data: parsed }).catch(() => {});
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** Hand the code to the server before Meta's 30-second TTL runs out. */
  const finish = useCallback(async (code: string) => {
    const state = pendingState.current;
    pendingState.current = null;
    if (!state) {
      setError("This connection attempt expired. Start it again.");
      return;
    }
    const result = await exchangeConnectCode({ data: { code, state } });
    if (!result.ok) {
      setError(failureCopy(result).detail);
      return;
    }
    if (!result.data.ok) {
      setError(result.data.error);
      return;
    }
    // The numbers table is a loader read; a reload is the honest way to show
    // what provisioning just did without duplicating its state here.
    window.location.assign(CONNECT_RETURN_PATH);
  }, []);

  async function start(path: ConnectPath) {
    setStarting(path);
    setError(null);
    try {
      const [config, handoff] = await Promise.all([
        getEmbeddedSignupConfig(),
        startConnect(),
      ]);
      if (!handoff.ok) {
        setError(failureCopy(handoff).detail);
        return;
      }

      // No SDK configured. The redirect still serves `new-number`; it CANNOT
      // serve `business-app`, so that one stops here rather than being handed
      // the flow that would take the number off the app.
      if (!config.ok || !config.data) {
        if (path === "business-app") {
          setError(SDK_REQUIRED_MESSAGE);
          return;
        }
        window.location.assign(handoff.data.url);
        return;
      }

      let sdk: Awaited<ReturnType<typeof loadFacebookSdk>>;
      try {
        sdk = await loadFacebookSdk(config.data.appId, config.data.graphVersion);
      } catch {
        // Blocked, offline, or an extension ate it. Same rule as above: the
        // redirect is a fallback for one path and a wrong answer for the other.
        if (path === "business-app") {
          setError(SDK_REQUIRED_MESSAGE);
          return;
        }
        window.location.assign(handoff.data.url);
        return;
      }

      pendingState.current = handoff.data.state;
      sdk.login((response) => {
        const code = response.authResponse?.code;
        if (!code) {
          // Closing the popup before the final screen is a cancel, not a
          // failure — the session event already recorded which screen it was.
          pendingState.current = null;
          setStarting(null);
          return;
        }
        void finish(code).finally(() => setStarting(null));
      }, loginOptions(config.data.configId, path));
      // The popup owns the flow now; `starting` is cleared by the callback.
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only the SDK path returns early with the popup still open.
      if (!pendingState.current) setStarting(null);
    }
  }

  return (
    <Frame variant="default" spacing="lg" className="max-w-3xl">
      <FramePanel fit>
        {/* The header sits level with the body: FramePanel zeroes the nested
            header's horizontal padding so the two do not stack (see frame.tsx). */}
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">{heading}</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            Pick the one that matches where the number lives today. Meta fixes
            this when the flow opens.
          </FrameDescription>
        </FrameHeader>

        {error ? (
          <p className={cn("mt-5", AUTH_ERROR_BANNER_CLASS)} role="alert">
            {error}
          </p>
        ) : null}

        {/* Each choice IS the action: there is nothing to configure between
            picking and launching, and a confirm step here would only add a
            click before Meta's own multi-screen flow, which is where backing
            out is still free. */}
        <ul className="m-0 flex list-none flex-col gap-px p-0 pt-5">
          {CONNECT_PATHS.map(({ path, title, detail, caution }) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => start(path)}
                disabled={starting !== null}
                className={cn(
                  "flex w-full flex-col items-start gap-1.5 rounded-none border border-(--line) p-4 text-left transition-colors",
                  "hover:border-(--ghost-edge-hover) hover:bg-(--ghost-fill-hover)",
                  "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                <span className="text-sm font-medium text-foreground">
                  {starting === path ? "Opening Embedded Signup…" : title}
                </span>
                <span className="max-w-prose text-pretty text-sm text-muted-foreground">
                  {detail}
                </span>
                {/* The consequence, in the functional register the design
                    contract reserves for it. It states a cost, never a
                    judgement about how well the path works. */}
                <span className="pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {caution}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <footer className="-mx-(--frame-panel-px) mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-(--frame-panel-border-color) px-(--frame-panel-px) pt-4">
          <p className="m-0 text-xs text-muted-foreground">
            Meta brings you back to this page when it is done.
          </p>
        </footer>
      </FramePanel>
    </Frame>
  );
}
