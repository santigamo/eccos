import { Button } from "@/components/ui/button";
import { ArrowRightIcon, CloudIcon, LoaderCircleIcon, SmartphoneIcon } from "lucide-react";
import type { ConnectPath } from "../../lib/embedded-signup";
import { failureCopy } from "../../lib/failure";
import type { ConnectBlock } from "../../server/connect-block";
import { Callout, ErrorReport } from "../ui/callout";
import { cn } from "@/lib/utils";
import { useEmbeddedSignup } from "./use-embedded-signup";

export { resetConnectGuards } from "./use-embedded-signup";


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

const OPEN_META_LABEL: Record<ConnectPath, string> = {
  "business-app": "Open Meta for my Business app number",
  "new-number": "Open Meta for a new number",
};

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
 * The question that frames the fork: the add-number dialog's description.
 */
export const CONNECT_FORK_DESCRIPTION = "Is this number on WhatsApp today?";

/** Said before Meta's window opens: a number another provider holds fails inside it (3441067). */
export const CONNECT_RELEASE_NOTE = {
  lead: "Coming from another WhatsApp provider?",
  rest: "Ask them to release the number first.",
};

const REPORT_LABELS = { copy: "Copy", copied: "Copied", failed: "Copy failed" };
const TROUBLESHOOTING_URL = "https://docs.eccos.chat/connect-troubleshooting";

/** What stands before a connection may start: a role that may not connect. */
export function ConnectBlockNotice({ block }: { block: ConnectBlock | null }) {
  return block === "missing-permission" ? <p className={NOTICE_CLASS}>{MISSING_PERMISSION_COPY}</p> : null;
}

/**
 * The add-number fork: two paths, each card IS the action, with no container
 * of its own (the dialog on the populated /numbers frames it). First run uses
 * the wizard in `components/connect-wizard/` instead; both drive Meta through
 * `useEmbeddedSignup`, so the flow exists once.
 */
export function ConnectNumberChoices({
  className,
  blocked = null,
  closed = false,
  onBusyChange,
  navigate = (path) => window.location.assign(path),
  popupWatchdogMs = 4_000,
  abandonDelayMs = 1_500,
}: {
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
  const signup = useEmbeddedSignup({ blocked, closed, navigate, popupWatchdogMs, abandonDelayMs, onBusyChange });
  const { starting, awaiting, feedback, block, unavailable, start, begin, startAgain } = signup;
  /** A flow is opening, or waiting for the click that opens it. */
  const locked = starting !== null || awaiting !== null;
  const selected = starting ?? awaiting;

  const reported = feedback?.tone === "meta" ? feedback.error : null;
  return (
    <div className={cn("flex flex-col gap-6", className)}>
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

      <ConnectBlockNotice block={block} />

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
