import { useCallback, useEffect, useRef, useState } from "react";
import { followSignIn } from "../../lib/follow-sign-in";
import {
  CONNECT_RETURN_PATH,
  exchangeConnectCode,
  getConnectReadiness,
  getEmbeddedSignupConfig,
  recordConnectSessionEvent,
  startConnect,
} from "../../server/gateway";
import { type FacebookSdk, captureWindowOpen, currentFacebookSdk, loadFacebookSdk } from "../../lib/facebook-sdk";
import { type ConnectPath, isFinishEvent, loginOptions, parseSessionEvent } from "../../lib/embedded-signup";
import { track, trackSessionEvent } from "../../lib/analytics";
import { failureCopy } from "../../lib/failure";
import { STEP_UP_COPY, stepUpReason } from "../../lib/step-up";
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
import type { ConnectLive } from "../../lib/connect-live";

/**
 * Once per page load, not per instance: a container can be closed and reopened
 * mid-flow, and Meta's SDK still holds the first instance's callback.
 * `exchanging` allows one exchange in flight; `left` is set once this page is
 * done connecting (navigating away, or connected in place), so no later code
 * can register the number a second time.
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

/**
 * The server-side redirect cannot serve coexistence: Meta ignores `extras` on
 * `dialog/oauth` (proved 2026-09-01), so falling back would silently run the
 * flow that takes the number off the app. Failing loudly is the only safe answer.
 */
const SDK_REQUIRED_MESSAGE =
  "Connecting a number that is already on the WhatsApp Business app needs Meta's script, which did not load. Check for a blocker or an extension and try again. Do not use the other option: it would take the number off the app.";

export type Feedback =
  /** `step` is the screen Meta's window was closed on, for a cancel. */
  | { tone: "error" | "notice" | "blocked" | "slow"; text: string; step?: string }
  /** Meta reported an error before its window closed: a problem to fix, not a change of mind. */
  | { tone: "meta"; error: ReportedSignupError; code: string };

function cancelledFeedback(step?: string, error?: { code?: string; sessionId?: string }): Feedback {
  const reported = reportedSignupError(step, error);
  return reported && error?.code
    ? { tone: "meta", error: reported, code: error.code }
    : { tone: "notice", text: connectCancelledMessage(step), step };
}

/**
 * Meta Embedded Signup, with no UI of its own: the fork on /numbers and the
 * first-run wizard both render it, so the popup handling, session logging, the
 * code exchange, step-up and the role block exist once.
 *
 * Preferred is Meta's JavaScript SDK: `FB.login()` opens the flow in a popup and
 * returns an exchangeable code, and a `message` listener captures session
 * logging (the screen a customer abandoned on and the error code they
 * reported). The fallback is the server-side redirect to the gateway's
 * `/connect`, used whenever the SDK is not configured or does not load; it
 * cannot serve the Business app path.
 *
 * The authorization code never buys anything in the browser: it is posted
 * straight to a session-authenticated server function.
 */
export function useEmbeddedSignup({
  blocked = null,
  closed = false,
  navigate = (path) => window.location.assign(path),
  popupWatchdogMs = 4_000,
  abandonDelayMs = 1_500,
  onBusyChange,
  stayOnConnect = false,
}: {
  /** What stops the signed-in user connecting right now: the role, or a step-up owed. */
  blocked?: ConnectBlock | null;
  /** A closed workspace with nothing to reconnect: nothing is prepared. */
  closed?: boolean;
  /** Full navigation. A seam for tests. */
  navigate?: (path: string) => void;
  /** How long Meta's window may stay out of sight before we say it may be behind this one. */
  popupWatchdogMs?: number;
  /** How long a closed window waits for a racing CANCEL message before the abandonment is recorded. */
  abandonDelayMs?: number;
  /** Told whenever a flow opens or settles, so a container can refuse to be dismissed under it. */
  onBusyChange?: (busy: boolean) => void;
  /** A clean connect stays on this page (`live.connected`) instead of reloading /numbers. */
  stayOnConnect?: boolean;
}) {
  /** The path whose flow is opening, or null. */
  const [starting, setStarting] = useState<ConnectPath | null>(null);
  /** What the customer is told. One live region carries all of it. */
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** Set when the click found something unready and had to wait: Meta opens from a fresh click. */
  const [awaiting, setAwaiting] = useState<ConnectPath | null>(null);
  /** What this page has actually observed of the current attempt. */
  const [live, setLive] = useState<ConnectLive>({});
  const setError = useCallback((text: string) => setFeedback({ text, tone: "error" }), []);
  /**
   * What still stands before a connection may start, the role first. A step-up
   * is settled before Meta is opened: the window only opens on the customer's
   * own click, and a prompt in between would spend it. A fresh read is applied
   * once, and never onto a flow that is already open.
   */
  const [block, setBlock] = useState(blocked);
  const applied = useRef(blocked);
  useEffect(() => {
    if (starting !== null || applied.current === blocked) return;
    applied.current = blocked;
    setBlock(blocked);
  }, [blocked, starting]);
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
   * The config and the SDK, loaded on mount so the click can call `FB.login`
   * in its own task: browsers only let `window.open` through while the click's
   * user activation lives.
   */
  const prepared = useRef<Prepared | null>(null);
  const preparing = useRef<Promise<Prepared> | null>(null);
  /** Each attempt's session, keyed by the window it opened, so a message counts for the attempt that posted it. */
  const sessions = useRef(new WeakMap<object, Session>());
  /** Why Connect cannot start at all, found on mount. */
  const [unavailable, setUnavailable] = useState<string | null>(null);

  /**
   * Session logging, mounted for the life of the component: Meta posts the
   * abandonment event as the popup closes, and a listener torn down on close
   * races it. `parseSessionEvent` drops anything not from a facebook.com origin.
   */
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const parsed = parseSessionEvent(event.origin, event.data);
      if (!parsed) return;
      const mine = event.source ? sessions.current.get(event.source) : undefined;
      if (!mine || mine.attempt === attempt.current) {
        stopWatch.current?.();
        setFeedback((now) => (now?.tone === "slow" ? null : now));
        // Meta's window is demonstrably open, and FINISH says its screens are done.
        setLive((now) =>
          now.launchedAt === undefined
            ? now
            : {
                ...now,
                openedAt: now.openedAt ?? Date.now(),
                ...(isFinishEvent(parsed.event) ? { finishedAt: now.finishedAt ?? Date.now() } : {}),
              },
        );
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
   * Between `FB.login` and its callback this hook holds the `message` listener
   * and the `finish` closure; a container that unmounted it would lose a
   * failure and the abandonment event, so it may refuse to be dismissed.
   */
  useEffect(() => {
    onBusyChange?.(starting !== null);
  }, [starting, onBusyChange]);

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
    // Creates no state and writes no audit. Only a definite "cannot connect" disables the start.
    getConnectReadiness().then(
      (res) => {
        const reason = res.ok ? (res.data.ready ? null : res.data.reason) : res.kind === "unreachable" ? null : failureCopy(res).detail;
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
          // The state is spent and provisioning may have run: a retry would re-onboard the number.
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
        const verdict = judgeExchange(result.data);
        track("connect_outcome", { result: verdict.outcome });
        if (!verdict.navigate) {
          setError(verdict.message);
          return;
        }
        const refused = result.data.ok && result.data.subscriptionRequired === true;
        if (stayOnConnect && result.data.ok && verdict.outcome === "ok" && verdict.skipped === 0 && !refused) {
          guards.left = true;
          const phone = result.data.display_phone_number || result.data.connected[0]?.display_phone_number || "";
          setLive((now) => ({ ...now, connected: { at: Date.now(), phone } }));
          return;
        }
        // Anything short of a clean connect is explained by /numbers, a loader read.
        leave(returnPathFor(CONNECT_RETURN_PATH, verdict.skipped, refused));
      } finally {
        guards.exchanging = false;
      }
    },
    [leave, setError, stayOnConnect],
  );

  /**
   * Open Meta's window. SYNCHRONOUS up to and including `sdk.login`: it runs
   * straight from a click, and an `await` before `window.open` can lose the
   * click's user activation. Do not add one. The handoff is requested only
   * once a window exists, so a blocked popup never creates one.
   */
  function launch(path: ConnectPath, ready: Ready) {
    const mine = beginAttempt(path);
    const isCurrent = () => attempt.current === mine;
    const mySession: Session = { attempt: mine, count: 0, openedAt: Date.now() };
    setLive({ launchedAt: mySession.openedAt });
    // Set inside `window.open`, before the SDK sees its result, so a callback for a refused window is ignored.
    let refused = false;
    let started: Promise<Handoff | null> | null = null;
    // A callback that arrives inside `sdk.login` itself.
    let settled = false;
    // Whether the handoff failure has been shown; a code for a failure nobody saw must not be dropped silently.
    let shown = false;
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
        if (isCurrent()) {
          setFeedback((now) => (now?.tone === "slow" ? null : now));
          setLive((now) => ({ ...now, openedAt: now.openedAt ?? Date.now(), finishedAt: now.finishedAt ?? Date.now() }));
        }
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
      // Meta's CANCEL can land just after this callback, so the abandonment is recorded after a short wait.
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
      track("connect_outcome", { result: "popup_blocked" });
      setFeedback({ text: popupBlockedMessage(window.location.host), tone: "blocked" });
      setStarting(null);
      return;
    }
    if (settled) return;
    // `undefined` means `window.open` was not observable: a window may exist.
    if (popup) {
      sessions.current.set(popup, mySession);
      setLive((now) => ({ ...now, openedAt: now.openedAt ?? Date.now() }));
      track("es_popup_open");
    }
    started = startConnect().then(
      (handoff) => {
        if (handoff.ok) return handoff;
        const lapsed = stepUpReason(handoff);
        if (lapsed && isCurrent()) setBlock(lapsed);
        fail(lapsed ? STEP_UP_COPY[lapsed].connect : failureCopy(handoff).detail);
        return null;
      },
      (err) => {
        if (!followSignIn(err)) fail(err instanceof Error ? err.message : String(err));
        return null;
      },
    );
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
    setLive({});
    return mine;
  }

  function readyNow(): Ready | null {
    const p = prepared.current;
    if (!p?.sdk || !p.config.ok || !p.config.data) return null;
    return { sdk: p.sdk, configId: p.config.data.configId };
  }

  /** Open Meta for `path`, from a click. */
  function begin(path: ConnectPath) {
    const ready = readyNow();
    if (ready) launch(path, ready);
    else void startSlow(path);
  }

  /** The first click on a path: counted as the customer's choice. */
  function start(path: ConnectPath) {
    track("connect_choice", { path });
    begin(path);
  }

  /** The SDK was not loaded at the click: finish loading, then ask for a fresh click. */
  async function startSlow(path: ConnectPath) {
    const mine = beginAttempt(path);
    try {
      await preparing.current?.catch(() => null);
      const loaded = prepared.current;
      const { config, sdk } =
        loaded && (loaded.sdk || (path === "new-number" && !window.FB)) ? loaded : await prepare();
      if (attempt.current !== mine) return;
      if (!config.ok || !config.data || !sdk) {
        if (path === "business-app") {
          setError(config.ok ? SDK_REQUIRED_MESSAGE : failureCopy(config).detail);
          return;
        }
        const handoff = await startConnect();
        if (attempt.current !== mine) return;
        if (!handoff.ok) {
          const lapsed = stepUpReason(handoff);
          if (lapsed) setBlock(lapsed);
          else setError(failureCopy(handoff).detail);
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

  /** Drop the current attempt and its feedback. Refused while an exchange is in flight. */
  function startAgain() {
    if (guards.exchanging) return;
    stopWatch.current?.();
    attempt.current += 1;
    setAwaiting(null);
    setFeedback(null);
    setStarting(null);
    setLive({});
  }

  return {
    starting,
    awaiting,
    feedback,
    live,
    block,
    clearBlock: () => setBlock(null),
    unavailable,
    start,
    begin,
    startAgain,
  };
}
