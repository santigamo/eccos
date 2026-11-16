import { useEffect, useRef, useState } from "react";
import { AUTH_ERROR_BANNER_CLASS, AuthCard } from "../auth/auth-page";
import { FrameDescription, FrameHeader, FrameTitle } from "../reui/frame";
import { Button } from "../ui/button";
import { type LinkOutcome, type LinkStart, type LinkView, connectLinkApi } from "../../lib/connect-link/api";
import type { ConnectLinkCopy } from "../../lib/connect-link/en";
import { takeLinkToken } from "../../lib/connect-link/token";
import { loginOptions, parseSessionEvent } from "../../lib/embedded-signup";
import { type FacebookSdk, captureWindowOpen, currentFacebookSdk, loadFacebookSdk } from "../../lib/facebook-sdk";
import { cn } from "@/lib/utils";

type Ready = Extract<LinkView, { status: "ready" }>;
type Note = { text: string; tone: "error" | "notice" };
type Screen =
  | { at: "loading" }
  | { at: "message"; text: string }
  | { at: "ready"; view: Ready }
  | { at: "done"; title?: string; text: string };

/**
 * The connection link's landing page: Meta Embedded Signup for a number on the
 * WhatsApp Business app, started by whoever holds the link. It only ever runs
 * the `business-app` path; the other one would take the number off the phone.
 */
export function ConnectLinkLanding({
  copy,
  api = connectLinkApi,
  readToken = takeLinkToken,
  loadSdk = loadFacebookSdk,
}: {
  copy: ConnectLinkCopy;
  /** Seams for tests. */
  api?: typeof connectLinkApi;
  readToken?: () => string | null;
  loadSdk?: typeof loadFacebookSdk;
}) {
  const [screen, setScreen] = useState<Screen>({ at: "loading" });
  const [sdk, setSdk] = useState<FacebookSdk | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const token = useRef<string | null>(null);
  /** Which click is current, so a closed window's late callback cannot touch a newer attempt. */
  const attempt = useRef(0);

  // The first request that carries the token, and the one that marks the link opened: a
  // link preview fetches the page but never runs this.
  useEffect(() => {
    let live = true;
    token.current = readToken();
    if (!token.current) {
      setScreen({ at: "message", text: copy.gone(copy.sender) });
      return;
    }
    void api.view(token.current).then((view) => {
      if (!live) return;
      if (view === "limited" || view === "unreachable") setScreen({ at: "message", text: copy[view] });
      else if (view.status === "gone") setScreen({ at: "message", text: copy.gone(view.inviter ?? copy.sender) });
      else setScreen({ at: "ready", view });
    });
    return () => {
      live = false;
    };
  }, [api, copy, readToken]);

  const signup = screen.at === "ready" && !screen.view.closed ? screen.view.signup : null;
  // Loaded before the click: the browser only lets Meta's window open while the click is live.
  useEffect(() => {
    if (!signup) return;
    let live = true;
    loadSdk(signup.appId, signup.graphVersion).then(
      (loaded) => live && setSdk(loaded),
      () => live && setSdk("failed"),
    );
    return () => {
      live = false;
    };
  }, [signup, loadSdk]);

  // Session logging, which Meta requires on this path. Recorded for as long as the page lives.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const parsed = parseSessionEvent(event.origin, event.data);
      if (parsed && token.current) api.event(token.current, parsed);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [api]);

  if (screen.at === "loading" || screen.at === "message") {
    return (
      <Card copy={copy}>
        <p className="m-0 text-sm text-muted-foreground">{screen.at === "loading" ? copy.loading : screen.text}</p>
      </Card>
    );
  }
  if (screen.at === "done") {
    return (
      <Card copy={copy}>
        <FrameHeader className="gap-1.5 p-0">
          {screen.title ? <FrameTitle>{screen.title}</FrameTitle> : null}
          <FrameDescription>{screen.text}</FrameDescription>
        </FrameHeader>
      </Card>
    );
  }

  const { view } = screen;
  const gone = () => setScreen({ at: "message", text: copy.gone(view.inviter) });

  function settle(result: LinkOutcome | "limited" | "unreachable") {
    setBusy(false);
    if (result === "limited") return setNote({ text: copy.limited, tone: "error" });
    if (result === "unreachable") return setNote({ text: copy.failed, tone: "error" });
    switch (result.outcome) {
      case "connected":
        return setScreen({ at: "done", title: copy.connectedTitle, text: copy.connected(result.phone, view.workspace) });
      case "pending":
        return setScreen({ at: "done", text: copy.pending(view.inviter) });
      case "gone":
        return gone();
      case "denied":
        return setNote({ text: copy.cancelled, tone: "notice" });
      case "state":
        return setNote({ text: copy.attemptExpired, tone: "error" });
      case "owned":
        return setNote({ text: copy.owned(view.inviter), tone: "error" });
      case "no_waba":
        return setNote({ text: copy.noWaba, tone: "error" });
      case "subscription_required":
        return setNote({ text: copy.closed(view.inviter), tone: "error" });
      case "failed":
        return setNote({ text: copy.failed, tone: "error" });
    }
  }

  /** The handoff failed while Meta's window is open: end the attempt and say so now. */
  function startFailed(handoff: Exclude<LinkStart, { ok: true }> | "limited" | "unreachable") {
    attempt.current += 1;
    setBusy(false);
    if (handoff !== "limited" && handoff !== "unreachable" && handoff.code === "gone") return gone();
    const text =
      handoff === "limited"
        ? copy.limited
        : handoff !== "unreachable" && handoff.code === "subscription_required"
          ? copy.closed(view.inviter)
          : copy.failed;
    setNote({ text: `${text} ${copy.closeMeta}`, tone: "error" });
  }

  /**
   * SYNCHRONOUS up to `login`: an `await` before Meta's window opens can lose
   * the click. The state is asked for only once a window exists, so a page
   * view or a blocked pop-up never mints one.
   */
  function connect() {
    const linkToken = token.current;
    if (!linkToken || !signup || !sdk || sdk === "failed") return;
    const mine = ++attempt.current;
    setBusy(true);
    setNote(null);
    let refused = false;
    let settled = false;
    let started: Promise<LinkStart | "limited" | "unreachable"> | null = null;
    const onLogin = (response: { authResponse?: { code?: string } | null }) => {
      if (refused || mine !== attempt.current) return;
      settled = true;
      const code = response.authResponse?.code;
      if (!code) {
        setBusy(false);
        setNote({ text: copy.cancelled, tone: "notice" });
        return;
      }
      void (async () => {
        const handoff = await started;
        if (mine !== attempt.current || !handoff || handoff === "limited" || handoff === "unreachable" || !handoff.ok) return;
        settle(await api.exchange(linkToken, code, handoff.state));
      })();
    };
    try {
      captureWindowOpen(
        () => (currentFacebookSdk() ?? sdk).login(onLogin, loginOptions(signup.configId, "business-app")),
        (opened) => {
          refused = opened === null;
        },
      );
    } catch {
      setBusy(false);
      setNote({ text: copy.failed, tone: "error" });
      return;
    }
    if (refused) {
      setBusy(false);
      setNote({ text: copy.popupBlocked(window.location.host), tone: "error" });
      return;
    }
    if (settled) return;
    started = api.start(linkToken).then((handoff) => {
      if (mine === attempt.current && (handoff === "limited" || handoff === "unreachable" || !handoff.ok)) {
        startFailed(handoff);
      }
      return handoff;
    });
  }

  const blocked = view.closed
    ? copy.closed(view.inviter)
    : !view.signup
      ? copy.unavailable(view.inviter)
      : sdk === "failed"
        ? copy.scriptBlocked
        : null;
  return (
    <Card copy={copy}>
      <FrameHeader className="gap-1.5 p-0">
        <FrameTitle>{copy.title(view.workspace)}</FrameTitle>
        <FrameDescription>{copy.intro(view.inviter)}</FrameDescription>
      </FrameHeader>
      <div>
        <p className="m-0 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{copy.beforeTitle}</p>
        <ul className="mt-2 mb-0 flex list-disc flex-col gap-1 pl-5 text-sm text-foreground">
          {copy.before.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <p className="m-0 text-sm text-muted-foreground">{copy.meta}</p>
      {/* Mounted even while empty, so a filling region is announced. */}
      <output
        className={cn(
          "block",
          (blocked || note) &&
            (!blocked && note?.tone === "notice"
              ? "border-l-2 border-(--line-strong) px-3 py-2 text-sm text-muted-foreground"
              : AUTH_ERROR_BANNER_CLASS),
        )}
      >
        {blocked ?? note?.text}
      </output>
      {blocked ? null : (
        <Button type="button" onClick={connect} disabled={busy || !sdk}>
          {busy ? copy.connecting : sdk ? copy.button : copy.preparing}
        </Button>
      )}
    </Card>
  );
}

function Card({ copy, children }: { copy: ConnectLinkCopy; children: React.ReactNode }) {
  return (
    <div lang={copy.lang}>
      <AuthCard title={copy.pageTitle}>
        <div className="flex flex-col gap-4">{children}</div>
      </AuthCard>
    </div>
  );
}
