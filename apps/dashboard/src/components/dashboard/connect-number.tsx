import { Button } from "@/components/ui/button";
import { followSignIn } from "../../lib/follow-sign-in";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRightIcon, CloudIcon, LoaderCircleIcon, SmartphoneIcon } from "lucide-react";
import { Frame, FramePanel } from "../reui/frame";
import {
  CONNECT_RETURN_PATH,
  exchangeConnectCode,
  getConnectReadiness,
  getEmbeddedSignupConfig,
  recordConnectSessionEvent,
  startConnect,
} from "../../server/gateway";
import { type FacebookSdk, captureWindowOpen, currentFacebookSdk, loadFacebookSdk } from "../../lib/facebook-sdk";
import {
  type ConnectPath,
  loginOptions,
  parseSessionEvent,
} from "../../lib/embedded-signup";
import { track, trackSessionEvent } from "../../lib/analytics";
import { failureCopy } from "../../lib/failure";
import type { ConnectBlock } from "../../server/connect-block";
import {
  CONNECT_CLOSE_AND_RETRY,
  CONNECT_NOT_PREPARED,
  type ReportedSignupError,
  connectCancelledMessage,
  judgeExchange,
  popupBlockedMessage,
  popupHintMessage,
  reportedSignupError,
  returnPathFor,
  secondsBucket,
  watchPopup,
  watchWindow,
} from "../../lib/connect-result";
import { Callout, ErrorReport } from "../ui/callout";
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
 * card (in amber) rather than in a doc.
 */
const CONNECT_PATHS: ReadonlyArray<{
  path: ConnectPath;
  title: string;
  detail: string;
  /** The detail is a cost that destroys existing setup. */
  warn: boolean;
  icon: React.ReactNode;
}> = [
  {
    path: "business-app",
    icon: <SmartphoneIcon aria-hidden="true" className="size-4.5" />,
    warn: false,
    title: "I use this number in the WhatsApp Business app",
    detail: "Keep the phone at hand to scan Meta's QR code. The app keeps working.",
  },
  {
    path: "new-number",
    icon: <CloudIcon aria-hidden="true" className="size-4.5" />,
    warn: true,
    title: "A new number, or one not on WhatsApp",
    detail: "A number on WhatsApp today stops working in the app.",
  },
];

/**
 * Once per page load, not per instance: the dialog can be closed and reopened
 * mid-flow, and Meta's SDK still holds the first instance's callback.
 * `exchanging` allows one exchange in flight; `left` is set when the page is on
 * its way out, so no later code can register the number a second time.
 */
const guards = { exchanging: false, left: false };

/** The config does not change within a page session: fetched once, and a failure is not kept. */
let configRequest: Promise<EsConfig> | null = null;
function loadConfig(): Promise<EsConfig> {
  configRequest ??= getEmbeddedSignupConfig().then(
    (config) => {
      if (!config.ok) configRequest = null;
      return config;
    },
    (err) => {
      configRequest = null;
      throw err;
    },
  );
  return configRequest;
}

/** Test seam: module state must not leak between tests. */
export function resetConnectGuards(): void {
  guards.exchanging = false;
  guards.left = false;
  configRequest = null;
}

type Handoff = Awaited<ReturnType<typeof startConnect>>;
type EsConfig = Awaited<ReturnType<typeof getEmbeddedSignupConfig>>;
type Session = {
  /** The attempt that opened the window. */
  attempt: number;
  count: number;
  step?: string;
  /** The error the customer reported from inside the flow, while nothing but a CANCEL has followed it. */
  error?: { code?: string; sessionId?: string };
  openedAt: number;
  /** The window closed with no code, so the cancel notice is showing. */
  cancelled?: boolean;
};
type Prepared = { config: EsConfig; sdk: FacebookSdk | null };
/** What a click needs to open Meta with no awaiting. */
type Ready = { sdk: FacebookSdk; configId: string };

const OPEN_META_LABEL: Record<ConnectPath, string> = {
  "business-app": "Open Meta for my Business app number",
  "new-number": "Open Meta for a new number",
};

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

/** A neutral note above the cards: what stands before a connection may start. */
const NOTICE_CLASS =
  "m-0 border-l-2 border-(--line-strong) px-3 py-2 text-sm text-muted-foreground";

/** The same words a refused connect start would get, shown before anything is pressed. */
const MISSING_PERMISSION_COPY = failureCopy({
  ok: false,
  kind: "forbidden",
  reason: "missing-permission",
  error: "",
}).detail;

/**
 * The question that frames the fork, shared by both containers so they cannot
 * drift: the panel's title on first run, the dialog's description on the
 * populated page.
 */
export const CONNECT_FORK_DESCRIPTION = "Is this number on WhatsApp today?";

/** Said before Meta's window opens: a number another provider holds fails inside it (3441067). */
export const CONNECT_RELEASE_NOTE = {
  lead: "Coming from another WhatsApp provider?",
  rest: "Ask them to release the number first.",
};

const REPORT_LABELS = { copy: "Copy", copied: "Copied", failed: "Copy failed" };
const TROUBLESHOOTING_URL = "https://docs.eccos.chat/connect-troubleshooting";

type Feedback =
  | { tone: "error" | "notice" | "blocked" | "slow"; text: string }
  /** Meta reported an error before its window closed: a problem to fix, not a change of mind. */
  | { tone: "meta"; error: ReportedSignupError };

function cancelledFeedback(step?: string, error?: { code?: string; sessionId?: string }): Feedback {
  const reported = reportedSignupError(step, error);
  return reported ? { tone: "meta", error: reported } : { tone: "notice", text: connectCancelledMessage(step) };
}

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
  title,
  className,
  blocked = null,
  closed = false,
  onBusyChange,
  navigate = (path) => window.location.assign(path),
  popupWatchdogMs = 4_000,
  abandonDelayMs = 1_500,
}: {
  /** The panel's title, hidden while Meta's error takes its place. The dialog has its own. */
  title?: string;
  className?: string;
  /** What stops the signed-in user connecting right now: a role that may not. */
  blocked?: ConnectBlock | null;
  /** A closed workspace with nothing to reconnect: the cards are off and the caller says why. */
  closed?: boolean;
  /** Full navigation. A seam for tests. */
  navigate?: (path: string) => void;
  /** How long Meta's window may stay out of sight before we say it may be behind this one. */
  popupWatchdogMs?: number;
  /** How long a closed window waits for a racing CANCEL message before the abandonment is recorded. */
  abandonDelayMs?: number;
  /** Told whenever a flow opens or settles, so a container can refuse to be
   * dismissed under it. See the effect below. */
  onBusyChange?: (busy: boolean) => void;
}) {
  /** The path whose flow is opening, or null. Also disables the other card. */
  const [starting, setStarting] = useState<ConnectPath | null>(null);
  /**
   * What the customer is told: a failure (red), a neutral note such as closing
   * Meta's window, or a blocked popup (red, with the one way out). One live
   * region carries all of them, always mounted.
   */
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** Set when the click found something unready and had to wait: Meta opens from a fresh click on "Open Meta". */
  const [awaiting, setAwaiting] = useState<ConnectPath | null>(null);
  /** A flow is opening, or waiting for the click that opens it. */
  const locked = starting !== null || awaiting !== null;
  const selected = starting ?? awaiting;
  const setError = useCallback((text: string) => setFeedback({ text, tone: "error" }), []);
  /** A role that may not connect, known when the fork appears: told so before any card is pressed. */
  const block = blocked ?? null;
  const stopWatch = useRef<(() => void) | null>(null);
  /** Which attempt is current, so a stale window's cancel cannot touch a newer one. */
  const attempt = useRef(0);
  const leave = useCallback(
    (path: string) => {
      guards.left = true;
      navigate(path);
    },
    [navigate],
  );
  /**
   * The config and the SDK, loaded when the fork mounts so the click can call
   * `FB.login` in its own task. Browsers only let `window.open` through while
   * the click's transient user activation lives, so nothing is awaited between
   * the click and `sdk.login`. Nothing is requested from the gateway on mount.
   */
  const prepared = useRef<Prepared | null>(null);
  const preparing = useRef<Promise<Prepared> | null>(null);
  /** Each attempt's session, keyed by the window it opened, so a message counts for the attempt that posted it. */
  const sessions = useRef(new WeakMap<object, Session>());
  /** Why Connect cannot start at all, found on mount. */
  const [unavailable, setUnavailable] = useState<string | null>(null);

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
      // Every message is recorded: the session id must never be lost. Only the
      // abandonment summary needs to know which attempt's window posted it.
      const mine = event.source ? sessions.current.get(event.source) : undefined;
      // Meta's window is demonstrably open, so the "may be behind this one" hint
      // goes. Not for a message from an older attempt's window.
      if (!mine || mine.attempt === attempt.current) {
        stopWatch.current?.();
        setFeedback((now) => (now?.tone === "slow" ? null : now));
      }
      if (mine) {
        mine.count += 1;
        if (parsed.currentStep) mine.step = parsed.currentStep;
        // An error the customer got past is not why the window closed.
        if (parsed.errorCode) mine.error = { code: parsed.errorCode, sessionId: parsed.sessionId };
        else if (parsed.event !== "CANCEL") mine.error = undefined;
        // Meta's CANCEL can land just after the window closed: the notice catches up.
        if (mine.cancelled && mine.attempt === attempt.current) {
          setFeedback((now) =>
            now?.tone === "notice" || now?.tone === "meta" ? cancelledFeedback(mine.step, mine.error) : now,
          );
        }
      }
      trackSessionEvent(parsed);
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

  /** Load the config and the SDK. Shared by the mount effect and the click's slow path. */
  const prepare = useCallback((): Promise<Prepared> => {
    if (prepared.current?.sdk) return Promise.resolve(prepared.current);
    if (preparing.current) return preparing.current;
    const run = (async () => {
      const config = await loadConfig();
      const sdk =
        config.ok && config.data
          ? await loadFacebookSdk(config.data.appId, config.data.graphVersion).catch(() => null)
          : null;
      const next = { config, sdk };
      prepared.current = next;
      return next;
    })().finally(() => {
      preparing.current = null;
    });
    preparing.current = run;
    return run;
  }, []);

  useEffect(() => {
    if (closed) return;
    // Best effort: a failure here is retried, and shown, by the click.
    prepare().catch(() => {});
    // Creates no state and writes no audit. A transient failure is left to the
    // click; only a definite "cannot connect" disables the cards.
    getConnectReadiness().then(
      (res) => {
        const reason = res.ok ? (res.data.ready ? null : res.data.reason) : res.kind === "unreachable" ? null : failureCopy(res).detail;
        // Too late to matter once a flow has started: it owns the cards and the feedback.
        if (reason && attempt.current === 0) {
          setUnavailable(reason);
          setError(reason);
        }
      },
      () => {},
    );
  }, [closed, prepare, setError]);

  /** Hand the code to the server before Meta's 30-second TTL runs out. */
  const finish = useCallback(
    async (code: string, state: string) => {
      if (guards.left || guards.exchanging) return;
      guards.exchanging = true;
      try {
        let result: Awaited<ReturnType<typeof exchangeConnectCode>>;
        try {
          result = await exchangeConnectCode({ data: { code, state } });
        } catch (err) {
          if (followSignIn(err)) return;
          // The state is spent and provisioning may have run, so the outcome is
          // unknown. A retry would re-onboard the number: show the real state.
          track("connect_outcome", { result: "unknown" });
          leave(CONNECT_RETURN_PATH);
          return;
        }
        if (!result.ok) {
          if (result.kind === "unreachable") {
            track("connect_outcome", { result: "unknown" });
            leave(CONNECT_RETURN_PATH);
            return;
          }
          setError(failureCopy(result).detail);
          return;
        }
        // The server function audits every outcome. Only a failed exchange
        // stays here; everything that registered something lands on /numbers.
        const verdict = judgeExchange(result.data);
        track("connect_outcome", { result: verdict.outcome });
        if (!verdict.navigate) {
          setError(verdict.message);
          return;
        }
        // The numbers table is a loader read; a reload is the honest way to
        // show what provisioning just did without duplicating its state here.
        leave(
          returnPathFor(
            CONNECT_RETURN_PATH,
            verdict.skipped,
            result.data.ok && result.data.subscriptionRequired === true,
          ),
        );
      } finally {
        guards.exchanging = false;
      }
    },
    [leave, setError],
  );

  /**
   * Open Meta's window. SYNCHRONOUS up to and including `sdk.login`: it runs
   * straight from a click, and an `await` before `window.open` can lose the
   * click's user activation. Do not add one.
   *
   * `FB.login` does not carry our state to Meta, so the handoff is requested
   * only once a window exists and is awaited inside the callback, right before
   * the exchange that needs it. A page view or a blocked popup never creates one.
   */
  function launch(path: ConnectPath, ready: Ready) {
    const mine = beginAttempt(path);
    const isCurrent = () => attempt.current === mine;
    const mySession: Session = { attempt: mine, count: 0, openedAt: Date.now() };
    // Set inside `window.open`, before the SDK sees its result, so a callback
    // for a refused window (even a synchronous one) is ignored.
    let refused = false;
    let started: Promise<Handoff | null> | null = null;
    // A callback that arrives inside `sdk.login` itself.
    let settled = false;
    // Whether the handoff failure has been shown; a code that arrives for a
    // failure nobody saw must not be dropped silently.
    let shown = false;
    // The handoff fails while Meta's window is open: say so now, not after the
    // customer has been through the whole flow.
    const fail = (text: string) => {
      if (!isCurrent()) return;
      shown = true;
      attempt.current += 1;
      stopWatch.current?.();
      setFeedback({ text: `${text} ${CONNECT_CLOSE_AND_RETRY}`, tone: "error" });
      setStarting(null);
    };
    const onLogin = (response: { authResponse?: { code?: string } | null }) => {
      if (guards.left || refused) return;
      settled = true;
      if (isCurrent()) stopWatch.current?.();
      const code = response.authResponse?.code;
      if (code) {
        if (isCurrent()) setFeedback((now) => (now?.tone === "slow" ? null : now));
        void (async () => {
          try {
            const handoff = await started;
            if (handoff?.ok) await finish(code, handoff.data.state);
            else if (!shown) setError(CONNECT_NOT_PREPARED);
          } finally {
            if (isCurrent()) setStarting(null);
          }
        })();
        return;
      }
      // Closing the popup before the final screen is a cancel, not a failure.
      // Meta does not always post a CANCEL for a closed window, and the one it
      // posts can land just after this callback, so the abandonment is recorded
      // after a short wait, for every closed window.
      setTimeout(() => {
        const { count, step, openedAt } = mySession;
        track("es_abandon", { step: step ?? "none", events: count, after: secondsBucket(Date.now() - openedAt) });
        void recordConnectSessionEvent({
          data: { event: "POPUP_CLOSED", ...(step ? { currentStep: step } : {}) },
        }).catch(() => {});
      }, abandonDelayMs);
      if (!isCurrent()) return;
      track("connect_outcome", { result: "cancelled" });
      mySession.cancelled = true;
      setFeedback(cancelledFeedback(mySession.step, mySession.error));
      setStarting(null);
    };
    let popup: Window | null | undefined;
    try {
      popup = captureWindowOpen(
        () => (currentFacebookSdk() ?? ready.sdk).login(onLogin, loginOptions(ready.configId, path)),
        (opened) => {
          refused = opened === null;
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(null);
      return;
    }
    if (refused) {
      // The browser refused the window: definitive, and nothing was opened.
      track("connect_outcome", { result: "popup_blocked" });
      setFeedback({ text: popupBlockedMessage(window.location.host), tone: "blocked" });
      setStarting(null);
      return;
    }
    // A callback that came back inside `sdk.login` already ended this attempt.
    if (settled) return;
    // `undefined` means `window.open` was not observable: a window may exist.
    if (popup) {
      sessions.current.set(popup, mySession);
      track("es_popup_open");
    }
    started = startConnect().then(
      (handoff) => {
        if (handoff.ok) return handoff;
        fail(failureCopy(handoff).detail);
        return null;
      },
      (err) => {
        if (!followSignIn(err)) fail(err instanceof Error ? err.message : String(err));
        return null;
      },
    );
    // A window that took no focus looks like nothing happening.
    const hint = () => {
      track("connect_outcome", { result: "popup_slow" });
      setFeedback({ text: popupHintMessage(window.location.host), tone: "slow" });
    };
    stopWatch.current = popup ? watchWindow(popup, hint, popupWatchdogMs) : watchPopup(hint, popupWatchdogMs);
  }

  /** Reset the per-attempt state; the returned id tells later callbacks if they are still current. */
  function beginAttempt(path: ConnectPath): number {
    stopWatch.current?.();
    const mine = ++attempt.current;
    setStarting(path);
    setAwaiting(null);
    setFeedback(null);
    return mine;
  }

  /** The SDK and its config are loaded: the click can open Meta itself. */
  function readyNow(): Ready | null {
    const p = prepared.current;
    if (!p?.sdk || !p.config.ok || !p.config.data) return null;
    return { sdk: p.sdk, configId: p.config.data.configId };
  }

  function begin(path: ConnectPath) {
    const ready = readyNow();
    if (ready) launch(path, ready);
    else void startSlow(path);
  }

  function start(path: ConnectPath) {
    track("connect_choice", { path });
    begin(path);
  }

  /** The SDK was not loaded at the click: finish loading, then ask for a fresh click. */
  async function startSlow(path: ConnectPath) {
    const mine = beginAttempt(path);
    try {
      // A load already in flight may reject; prepare() then starts a fresh one.
      await preparing.current?.catch(() => null);
      // A finished load that failed is not repeated for the redirect, which
      // needs no SDK. The Business app path has no fallback, so it reloads.
      const loaded = prepared.current;
      // An SDK that finished loading after a failed attempt is used as it is.
      const { config, sdk } =
        loaded && (loaded.sdk || (path === "new-number" && !window.FB)) ? loaded : await prepare();
      if (attempt.current !== mine) return;
      // No SDK configured, or it would not load (blocked, offline, an
      // extension). The redirect still serves `new-number`; it CANNOT serve
      // `business-app`, so that one stops here rather than being handed the
      // flow that would take the number off the app.
      if (!config.ok || !config.data || !sdk) {
        if (path === "business-app") {
          setError(config.ok ? SDK_REQUIRED_MESSAGE : failureCopy(config).detail);
          return;
        }
        const handoff = await startConnect();
        if (attempt.current !== mine) return;
        if (!handoff.ok) {
          setError(failureCopy(handoff).detail);
          return;
        }
        leave(handoff.data.url);
        return;
      }
      // Awaiting spent the click's activation: Meta opens from the next one.
      setAwaiting(path);
    } catch (err) {
      if (followSignIn(err)) return;
      if (attempt.current !== mine) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (attempt.current === mine) setStarting(null);
    }
  }

  function startAgain() {
    if (guards.exchanging) return;
    stopWatch.current?.();
    attempt.current += 1;
    setAwaiting(null);
    setFeedback(null);
    setStarting(null);
  }

  const reported = feedback?.tone === "meta" ? feedback.error : null;
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {title && !reported ? (
        <h2 className="m-0 text-lg leading-6 font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
      ) : null}
      {/* Mounted even while empty, so a filling region is announced; out of the flow while empty. */}
      <output
        className={cn(
          "block empty:sr-only",
          (feedback?.tone === "notice" || feedback?.tone === "slow") &&
            "border-l-2 border-(--line-strong) py-0.5 pl-4 text-sm text-muted-foreground",
        )}
      >
        {feedback?.tone === "notice" || feedback?.tone === "slow" ? feedback.text : null}
        {feedback?.tone === "slow" ? (
          <button type="button" onClick={startAgain} className="ml-2 underline underline-offset-2">
            Start again
          </button>
        ) : null}
        {feedback?.tone === "error" || feedback?.tone === "blocked" ? (
          <Callout tone="error">{feedback.text}</Callout>
        ) : null}
        {reported ? <ErrorReport status="Not connected" labels={REPORT_LABELS} {...reported} /> : null}
      </output>

      {block === "missing-permission" ? <p className={NOTICE_CLASS}>{MISSING_PERMISSION_COPY}</p> : null}

      {awaiting ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-sm text-muted-foreground">Ready. Meta opens in its own window.</p>
          <div className="flex items-center gap-3">
            <Button type="button" onClick={() => begin(awaiting)} disabled={unavailable !== null}>
              {OPEN_META_LABEL[awaiting]}
            </Button>
            <button type="button" onClick={startAgain} className="text-sm underline underline-offset-2">
              Choose again
            </button>
          </div>
        </div>
      ) : null}

      {/* Hidden while Meta's own error is on screen: it would say the same thing twice. */}
      {reported ? null : (
        <Callout tone="warning">
          <strong className="font-semibold">{CONNECT_RELEASE_NOTE.lead}</strong> {CONNECT_RELEASE_NOTE.rest}
        </Callout>
      )}

      <div className="flex flex-col gap-2">
        {reported ? (
          <p className="m-0 border-t border-border pt-6 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Start again
          </p>
        ) : null}
        {/* Each choice IS the action: there is nothing to configure between
            picking and launching, and a confirm step here would only add a
            click before Meta's own multi-screen flow, which is where backing
            out is still free. `gap-2`, not `gap-px`: two bordered rows sharing
            a seam read as table rows, not as two controls at a fork. */}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {CONNECT_PATHS.map(({ path, title: pathTitle, detail, warn, icon }) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => start(path)}
                disabled={closed || locked || unavailable !== null || block !== null}
                className={cn(
                  // Interactive anatomy: `--ghost-fill` under a `--line-strong`
                  // edge, the edge going green on hover (docs/DASHBOARD-DESIGN.md).
                  "group flex w-full items-start gap-4 rounded-none border border-(--line-strong) bg-(--ghost-fill) p-5 text-left transition-colors",
                  "hover:border-(--ghost-edge-hover) hover:bg-(--ghost-fill-hover)",
                  "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none",
                  // Dim only the path NOT being opened. Dimming the one just
                  // pressed reads as "unavailable" at the exact moment it is
                  // the thing that is working.
                  "disabled:pointer-events-none",
                  selected !== null && selected !== path && "opacity-50",
                  awaiting === path && "border-(--ghost-edge-hover) bg-(--ghost-fill-hover)",
                )}
              >
                {/* The masthead's monogram idiom: a square with a
                    `--line-strong` edge. The glyph carries brand green at 70%
                    at rest, a mark rather than a state, and brightens on hover. */}
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center border border-(--line-strong) text-ink/70 transition-colors group-hover:border-(--ghost-edge-hover) group-hover:text-ink"
                >
                  {starting === path ? <LoaderCircleIcon className="size-4.5 animate-spin" /> : icon}
                </span>
                {/* The title does NOT become "Opening…": the spinner in the slot
                    says it without moving anything. */}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[15px] leading-5 font-semibold text-foreground">{pathTitle}</span>
                  <span
                    className={cn(
                      "text-sm text-pretty",
                      warn ? "font-medium text-warning-foreground" : "text-muted-foreground",
                    )}
                  >
                    {detail}
                  </span>
                </span>
                <span aria-hidden="true" className="flex h-10 w-5 shrink-0 items-center justify-center text-foreground">
                  <ArrowRightIcon className="size-4.5" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <p className="m-0 text-sm text-muted-foreground">
        Stuck?{" "}
        <a href={TROUBLESHOOTING_URL} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">
          Troubleshooting guide
        </a>
      </p>
    </div>
  );
}

/**
 * The framed panel around the fork, FIRST RUN ONLY. The populated page opens
 * the same fork in a centred dialog, which brings its own title, so the split
 * keeps one fork in two containers instead of a panel inside a panel.
 */
export function ConnectNumberPanel({ closed, blocked }: { closed?: boolean; blocked?: ConnectBlock | null }) {
  return (
    <Frame variant="default" spacing="lg" className="max-w-3xl">
      <FramePanel fit>
        <ConnectNumberChoices title={CONNECT_FORK_DESCRIPTION} closed={closed} blocked={blocked} />
      </FramePanel>
    </Frame>
  );
}
