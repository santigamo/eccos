import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
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
import { isFinishEvent, loginOptions, parseSessionEvent } from "../../lib/embedded-signup";
import { failureCopy } from "../../lib/failure";
import { AUTH_ERROR_BANNER_CLASS } from "../auth/auth-page";
import { cn } from "@/lib/utils";

/** What Embedded Signup will ask for, in order. Fragments, not sentences. */
const CONNECT_STEPS = [
  "Pick or create a WhatsApp Business Account",
  "Attach the phone number Eccos will use",
  "Eccos subscribes to its webhooks",
] as const;

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
  const [starting, setStarting] = useState(false);
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

  async function start() {
    setStarting(true);
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

      // No SDK configured: the redirect path, unchanged.
      if (!config.ok || !config.data) {
        window.location.assign(handoff.data.url);
        return;
      }

      let sdk: Awaited<ReturnType<typeof loadFacebookSdk>>;
      try {
        sdk = await loadFacebookSdk(config.data.appId, config.data.graphVersion);
      } catch {
        // Blocked, offline, or an extension ate it. The redirect needs no
        // third-party script and the state we already minted is still good.
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
          setStarting(false);
          return;
        }
        void finish(code).finally(() => setStarting(false));
      }, loginOptions(config.data.configId));
      // The popup owns the flow now; `starting` is cleared by the callback.
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only the SDK path returns early with the popup still open.
      if (!pendingState.current) setStarting(false);
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
            Meta opens in this tab. Your number stays on the WhatsApp Business
            app.
          </FrameDescription>
        </FrameHeader>

        <ol className="m-0 flex list-none flex-col gap-2.5 p-0 pt-5">
          {CONNECT_STEPS.map((text, i) => (
            <li key={text} className="flex items-baseline gap-3">
              <span
                aria-hidden="true"
                className="text-[11px] font-medium tabular-nums tracking-wider text-muted-foreground"
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-sm text-foreground">{text}</span>
            </li>
          ))}
        </ol>

        {error ? (
          <p className={cn("mt-4", AUTH_ERROR_BANNER_CLASS)} role="alert">
            {error}
          </p>
        ) : null}

        {/* One footer rail, action pinned right; full-bleed so its rule reads as
            panel chrome rather than as another content block. */}
        <footer className="-mx-(--frame-panel-px) mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-(--frame-panel-border-color) px-(--frame-panel-px) pt-4">
          <p className="m-0 text-xs text-muted-foreground">
            Meta brings you back to this page when it is done.
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" onClick={start} disabled={starting}>
              {starting ? "Opening Embedded Signup…" : "Connect WhatsApp"}
            </Button>
          </div>
        </footer>
      </FramePanel>
    </Frame>
  );
}
