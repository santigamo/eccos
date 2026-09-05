import { useCallback, useEffect, useRef, useState } from "react";
import { CloudIcon, LoaderCircleIcon, SmartphoneIcon } from "lucide-react";
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
  /** `warning` is reserved for a path that destroys existing setup. */
  tone: "warning" | "muted";
  icon: React.ReactNode;
}> = [
  {
    path: "business-app",
    icon: <SmartphoneIcon aria-hidden="true" className="size-4" />,
    tone: "muted",
    title: "Keep the number on the WhatsApp Business app",
    detail:
      "You keep answering from the app. Meta syncs contacts and message history across both.",
    caution: "Syncs run once · 20 messages/second cap",
  },
  {
    path: "new-number",
    icon: <CloudIcon aria-hidden="true" className="size-4" />,
    tone: "warning",
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
 * The sentence that frames the fork, shared by both containers so they cannot
 * drift: the panel puts it in `FrameDescription` on first run, the dialog in
 * `DialogDescription` on the populated page. Both readings need it BEFORE the
 * cards, because "the choice locks" is the reason the fork is a screen at all.
 */
export const CONNECT_FORK_DESCRIPTION =
  "Pick the one that matches where the number lives today. The choice locks the moment Meta's window opens.";

/**
 * Start Meta Embedded Signup: the fork itself, with no container of its own.
 *
 * Rendered as the empty state of /numbers on first run (through
 * `ConnectNumberPanel` below, which frames it) and, later, from the same page
 * when the operator adds another number (inside a centred dialog, which frames
 * it differently). Connecting a number is a recurring operation, not a
 * first-run ritual, so it has one surface rather than a wizard that only
 * exists once — and this component is that surface, minus the frame, so the
 * two containers cannot drift into two forks.
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
export function ConnectNumberChoices({
  className,
  onBusyChange,
}: {
  className?: string;
  /** Told whenever a flow opens or settles, so a container can refuse to be
   * dismissed under it. See the effect below. */
  onBusyChange?: (busy: boolean) => void;
}) {
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

  /**
   * Tell the container a flow is in flight, so it can refuse to be dismissed.
   *
   * This is the one thing the fork cannot own itself. Between `FB.login` and
   * its callback, Meta's popup holds the flow while THIS component holds the
   * `message` listener above and the `finish` closure below. A container that
   * unmounted us here would not cancel any of it: the code exchange still
   * completes, but a failure's `setError` lands on nothing and the abandonment
   * event is lost. The dialog on /numbers refuses backdrop and Escape while
   * this is true, per the overlay rule's dismissal corollary
   * (docs/DASHBOARD-DESIGN.md) — an explicit close stays available, because
   * being unable to leave is the bug this whole surface came from.
   *
   * First run passes nothing: there is no container to close.
   */
  useEffect(() => {
    onBusyChange?.(starting !== null);
  }, [starting, onBusyChange]);

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
    <div className={cn("flex flex-col gap-4", className)}>
      {error ? (
        <p className={AUTH_ERROR_BANNER_CLASS} role="alert">
          {error}
        </p>
      ) : null}

      {/* Each choice IS the action: there is nothing to configure between
            picking and launching, and a confirm step here would only add a
            click before Meta's own multi-screen flow, which is where backing
            out is still free.

            `gap-2`, not `gap-px`: two bordered rows sharing a 1px seam is the
            anatomy of TABLE ROWS, and that is most of why this panel read as a
          grid rather than as two controls at a fork. */}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {CONNECT_PATHS.map(({ path, title, detail, caution, tone, icon }) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => start(path)}
                disabled={starting !== null}
                className={cn(
                  // INTERACTIVE anatomy, not structural. These rested on
                  // `--line` (7%, "structural hairlines") with no fill, which
                  // is the ink of dividers — so the two biggest actions in the
                  // product were drawn like the rules between them, and the
                  // affordance existed only on hover. The contract's rule for a
                  // ghost control is `--ghost-fill` under a `--line-strong`
                  // (35%) edge, which is also what the landing's `.btn-ghost`
                  // does. Rest -> hover then reads as fill-raise plus the edge
                  // going green, instead of a hairline appearing from nothing.
                  "group flex w-full items-start gap-4 rounded-none border border-(--line-strong) bg-(--ghost-fill) p-4 text-left transition-colors",
                  "hover:border-(--ghost-edge-hover) hover:bg-(--ghost-fill-hover)",
                  "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none",
                  // Dim only the path NOT being opened. Dimming the one just
                  // pressed reads as "unavailable" at the exact moment it is
                  // the thing that is working.
                  "disabled:pointer-events-none",
                  starting !== null && starting !== path && "opacity-50",
                )}
              >
                {/* The masthead's monogram idiom: a square with a
                    `--line-strong` edge, never a circle, never rounded.
                    
                    THE GLYPH CARRIES BRAND GREEN AT REST, at 70%. That is a
                    deliberate departure from the strict reading of the
                    interaction law, which reserves resting green for STATE (the
                    live sidebar item, a success tag, the primary CTA) on the
                    grounds that spending it elsewhere dilutes "green marks the
                    live thing". The departure is bounded so that argument still
                    holds: only the glyph is tinted, never the slot's fill or
                    edge, so this stays a mark and never becomes the filled,
                    railed, full-ink block the sidebar uses for "active" — and
                    at 70% it is visibly quieter than any real state on screen.
                    
                    Hover then takes it to 100%, which is also the rule the
                    contract states outright: vivid green never dims, it
                    brightens. So rest -> hover keeps a distinct step, and the
                    edge going green stays the interactivity signal it was. */}
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center border border-(--line-strong) text-primary/70 transition-colors group-hover:border-(--ghost-edge-hover) group-hover:text-primary"
                >
                  {starting === path ? (
                    <LoaderCircleIcon className="size-4 animate-spin" />
                  ) : (
                    icon
                  )}
                </span>
                <span className="flex min-w-0 flex-col gap-1.5">
                  {/* The title does NOT become "Opening…". Swapping it jumps
                      the layout and erases which path is opening at the one
                      moment that matters; the spinner in the slot says it
                      without moving anything. */}
                  <span className="text-sm font-medium text-foreground">{title}</span>
                  <span className="max-w-prose text-pretty text-sm text-muted-foreground">
                    {detail}
                  </span>
                  {/* The consequence, in the functional register the contract
                      reserves for it. Amber is spent here and nowhere else on
                      this screen: it is the one meaningful state, and it is the
                      mistake the fork exists to prevent. Red would be wrong —
                      that is the error register, and this path is the CORRECT
                      choice for a fresh number. No icon and no chip: the words
                      carry the meaning, a warning triangle would push it to
                      alarm, and tag anatomy would misdeclare a cost as status. */}
                  <span
                    className={cn(
                      "pt-1 text-[11px] font-medium uppercase tracking-wider",
                      tone === "warning" ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {caution}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

      {/* No footer band. A full-bleed rule and its chrome for one 12px
          sentence was another rectangle in a panel that already had too
          many; the sentence earns its place (it sets the return expectation,
          which matters most on the full-navigation fallback) and the rule
          did not. */}
      <p className="m-0 text-xs text-muted-foreground">
        Meta brings you back to this page when it is done.
      </p>
    </div>
  );
}

/**
 * The framed panel around the fork — FIRST RUN ONLY.
 *
 * With no number yet, /numbers IS this screen: the panel is the whole point,
 * so it keeps its own `Frame`, its own heading in the MACHINE VOICE (Inter,
 * 11px, uppercase, tracking-wider — what the design contract gives panel
 * titles and empty-state labels; it was stock shadcn card-title, a register
 * this console does not have), and its designed `max-w-3xl`.
 *
 * The populated page does NOT use this. There the same fork opens in a centred
 * dialog, which supplies its own title and description slots, so wrapping
 * `ConnectNumberChoices` in a second bordered, glass-filled surface would be a
 * panel inside a panel. That is why the split exists: one fork, two containers,
 * and the container is the only thing that differs.
 */
export function ConnectNumberPanel({ heading }: { heading: string }) {
  return (
    <Frame variant="default" spacing="lg" className="max-w-3xl">
      <FramePanel fit>
        {/* The header sits level with the body: FramePanel zeroes the nested
            header's horizontal padding so the two do not stack (see frame.tsx). */}
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {heading}
          </FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            {CONNECT_FORK_DESCRIPTION}
          </FrameDescription>
        </FrameHeader>
        <ConnectNumberChoices className="pt-5" />
      </FramePanel>
    </Frame>
  );
}
