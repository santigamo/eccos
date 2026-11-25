import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ConnectPath } from "../../lib/embedded-signup";
import type { ConnectBlock } from "../../server/connect-block";
import { helpContext, troubleFor } from "../../lib/connect-trouble";
import { ConnectBlockNotice } from "../dashboard/connect-number";
import { useEmbeddedSignup } from "../dashboard/use-embedded-signup";
import { Callout } from "../ui/callout";
import { BriefStep } from "./brief-step";
import { IconStep } from "./icon-step";
import { ConnectedStep, LiveStep } from "./live-step";
import { PathStep } from "./path-step";
import { ReadyStep } from "./ready-step";
import { TroubleStep } from "./trouble-step";
import { FounderNote, WIZARD_STEPS, WizardProgress } from "./wizard-frame";
import { WriteStep } from "./write-step";

export const SETUP_PATH = "/setup";

type Step = "ready" | "path" | "icon" | "brief";
const STEP_NUMBER: Record<Step, number> = { ready: 1, path: 2, icon: 2, brief: 3 };

/**
 * First run on /numbers: get ready, choose the path (with the "which icon"
 * check), read what Meta will show, then connect with a live status that moves
 * only on what this page observes. A second number keeps the add-number dialog.
 *
 * It ends at "connected": Continue loads /setup (eccos-dbb3.6), the goal
 * chooser and live tests. A full load, so the root reads the new number.
 */
export function ConnectWizard({
  blocked = null,
  closed = false,
  navigate = (path) => window.location.assign(path),
  onContinue,
  popupWatchdogMs,
  abandonDelayMs,
}: {
  blocked?: ConnectBlock | null;
  closed?: boolean;
  navigate?: (path: string) => void;
  onContinue?: () => void;
  popupWatchdogMs?: number;
  abandonDelayMs?: number;
}) {
  const signup = useEmbeddedSignup({ blocked, closed, navigate, popupWatchdogMs, abandonDelayMs, stayOnConnect: true });
  const { feedback, live, starting, awaiting } = signup;
  const [step, setStep] = useState<Step>("ready");
  const [path, setPath] = useState<ConnectPath | null>(null);
  /** Meta was opened from this wizard, so its feedback opens a troubleshooting screen. */
  const [launched, setLaunched] = useState(false);
  const [writing, setWriting] = useState(false);

  const trouble = launched ? troubleFor(feedback) : null;
  const base = live.connected ? "connected" : trouble ? "trouble" : starting && live.launchedAt ? "live" : step;
  const view = writing ? "write" : base;
  const progress = base === step ? STEP_NUMBER[step] : 4;

  // Each new screen moves focus to its heading, so a reader hears where they are. Not on first paint.
  const root = useRef<HTMLDivElement>(null);
  const painted = useRef(false);
  useEffect(() => {
    if (!painted.current) {
      painted.current = true;
      return;
    }
    const target = root.current?.querySelector<HTMLElement>("h2") ?? root.current?.querySelector<HTMLElement>("section");
    target?.focus();
  }, [view, trouble]);

  function go(next: Step) {
    setWriting(false);
    setStep(next);
  }
  function open(next: ConnectPath) {
    setPath(next);
    // A step-up lapsed mid-attempt: settle it on the brief, where its prompt lives.
    if (signup.block) {
      signup.startAgain();
      setLaunched(false);
      go("brief");
      return;
    }
    setLaunched(true);
    if (awaiting === next) signup.begin(next);
    else signup.start(next);
  }
  function otherNumber() {
    signup.startAgain();
    setLaunched(false);
    go("path");
  }

  const preLaunchError = !launched && feedback?.tone === "error" ? feedback.text : null;
  const chosen = path ?? "business-app";

  let screen: ReactNode;
  switch (view) {
    case "write":
      screen = (
        <WriteStep
          context={helpContext({ path, stage: WIZARD_STEPS[progress - 1] ?? "", feedback })}
          onBack={() => setWriting(false)}
        />
      );
      break;
    case "connected":
      screen = <ConnectedStep live={live} path={chosen} onContinue={onContinue ?? (() => navigate(SETUP_PATH))} />;
      break;
    case "trouble":
      screen = feedback && trouble ? (
        <TroubleStep
          trouble={trouble}
          feedback={feedback}
          onRetry={() => open(chosen)}
          onBusinessApp={() => open("business-app")}
          onOtherNumber={otherNumber}
        />
      ) : null;
      break;
    case "live":
      screen = (
        <LiveStep
          live={live}
          path={chosen}
          slow={feedback?.tone === "slow"}
          onCancel={() => {
            signup.startAgain();
            setLaunched(false);
            go("brief");
          }}
          onReopen={() => signup.begin(chosen)}
        />
      );
      break;
    case "ready":
      screen = <ReadyStep onContinue={() => go("path")} />;
      break;
    case "path":
      screen = (
        <PathStep
          onPick={(next) => {
            setPath(next);
            go("brief");
          }}
          onBack={() => go("ready")}
          onCheck={() => go("icon")}
        />
      );
      break;
    case "icon":
      screen = (
        <IconStep
          onBusinessApp={() => {
            setPath("business-app");
            go("brief");
          }}
          onOtherNumber={() => go("path")}
          onBack={() => go("path")}
        />
      );
      break;
    case "brief":
      screen = (
        <BriefStep
          path={chosen}
          awaiting={awaiting === chosen}
          disabled={closed || signup.unavailable !== null || signup.block !== null || starting !== null}
          onOpen={() => open(chosen)}
          onBack={() => go("path")}
          notice={
            <>
              <ConnectBlockNotice block={signup.block} onCleared={signup.clearBlock} />
              {preLaunchError ? <Callout tone="error">{preLaunchError}</Callout> : null}
            </>
          }
        />
      );
      break;
  }

  return (
    <div ref={root} className="flex w-full max-w-160 flex-col gap-4">
      <WizardProgress step={progress} />
      {screen}
      {view === "write" ? null : <FounderNote large={view === "trouble"} onWrite={() => setWriting(true)} />}
    </div>
  );
}
