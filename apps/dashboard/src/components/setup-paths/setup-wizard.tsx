import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Activation, markPaywallSeen } from "../../lib/activation";
import { FounderNote, PrimaryAction, WizardCard, WizardFooter, WizardHeading, WizardProgress } from "../connect-wizard/wizard-frame";
import { WriteStep } from "../connect-wizard/write-step";
import { ActivationPaywall, PAYWALL_TITLE, type Proof, ProofColumn } from "./activation-paywall";
import { type Goal, GoalStep } from "./goal-step";
import { InboxTest } from "./inbox-test";
import { KeyStep } from "./key-step";
import { SendTest } from "./send-test";
import { ToolAddressStep } from "./tool-address-step";
import { GUIDES, type Tool } from "./tool-guides";
import { ToolPickStep } from "./tool-pick-step";
import { ToolTest } from "./tool-test";

type View = "goal" | "inbox" | "tool-pick" | "tool-address" | "tool-test" | "key" | "send" | "paywall";

const PROGRESS: Record<View, [step: number, label?: string]> = {
  goal: [5],
  "tool-pick": [5],
  "tool-address": [5],
  key: [5],
  inbox: [6],
  "tool-test": [6],
  send: [6],
  paywall: [6, "Done"],
};

export type SetupWizardProps = {
  wabaId: string;
  phoneNumberId: string;
  /** The connected number, as people read it. */
  phone: string;
  gatewayOrigin: string | null;
  numbers: number;
  canManage: boolean;
  /** Billing is on and the workspace has no subscription yet: a success ends on the paywall. */
  offer: boolean;
  /** The server's activation (eccos-dbb3.2); present means the paywall is due. */
  activation: Activation | null;
  navigate: (path: string) => void;
  now?: () => number;
};

/**
 * Steps 5 and 6 of the funnel, after "Your number is connected": pick a goal,
 * set it up, prove it with a live test, then the paywall. The paywall shows
 * when the server reports activation, and at once when a test here succeeds.
 */
export function SetupWizard({
  wabaId,
  phoneNumberId,
  phone,
  gatewayOrigin,
  numbers,
  canManage,
  offer,
  activation,
  navigate,
  now = Date.now,
}: SetupWizardProps) {
  const [view, setView] = useState<View>(activation ? "paywall" : "goal");
  const [goal, setGoal] = useState<Goal | null>(null);
  const [tool, setTool] = useState<Tool>("make");
  const [savedAt, setSavedAt] = useState(0);
  const [savedUrl, setSavedUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [proof, setProof] = useState<Proof | null>(null);
  const [writing, setWriting] = useState(false);

  // Server activation arriving while the wizard is open shows the paywall too.
  useEffect(() => {
    if (activation) setView("paywall");
  }, [activation]);

  const root = useRef<HTMLDivElement>(null);
  const painted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new screen is the trigger
  useEffect(() => {
    if (!painted.current) {
      painted.current = true;
      return;
    }
    root.current?.querySelector<HTMLElement>("h2")?.focus();
  }, [view, writing]);

  function succeed(observed: Proof) {
    setProof(observed);
    setView("paywall");
  }

  function pick(next: Goal) {
    setGoal(next);
    setView(next === "inbox" ? "inbox" : next === "tool" ? "tool-pick" : "key");
  }

  let screen: ReactNode;
  switch (view) {
    case "goal":
      screen = <GoalStep phone={phone} onPick={pick} />;
      break;
    case "inbox":
      screen = (
        <InboxTest wabaId={wabaId} phoneNumberId={phoneNumberId} phone={phone} onBack={() => setView("goal")} onSuccess={succeed} now={now} />
      );
      break;
    case "tool-pick":
      screen = (
        <ToolPickStep
          onPick={(next) => {
            setTool(next);
            setView("tool-address");
          }}
          onBack={() => setView("goal")}
        />
      );
      break;
    case "tool-address":
      screen = (
        <ToolAddressStep
          guide={GUIDES[tool]}
          wabaId={wabaId}
          initialUrl={savedUrl}
          onSaved={(url, at) => {
            setSavedUrl(url);
            setSavedAt(at);
            setView("tool-test");
          }}
          onBack={() => setView("tool-pick")}
        />
      );
      break;
    case "tool-test":
      screen = (
        <ToolTest
          guide={GUIDES[tool]}
          wabaId={wabaId}
          phone={phone}
          savedAt={savedAt}
          onChangeAddress={() => setView("tool-address")}
          onBack={() => setView("tool-address")}
          onSuccess={succeed}
        />
      );
      break;
    case "key":
      screen = (
        <KeyStep
          onIssued={(key) => {
            setApiKey(key);
            setView("send");
          }}
          onBack={() => setView("goal")}
        />
      );
      break;
    case "send":
      screen = (
        <SendTest
          wabaId={wabaId}
          phoneNumberId={phoneNumberId}
          apiKey={apiKey}
          gatewayOrigin={gatewayOrigin}
          onBack={() => setView("goal")}
          onSuccess={succeed}
          now={now}
        />
      );
      break;
    case "paywall": {
      const onContinue = () => {
        markPaywallSeen();
        navigate(goal === "inbox" ? "/conversations" : "/");
      };
      screen = (
        <WizardCard>
          {offer ? (
            <ActivationPaywall
              proof={proof}
              numbers={numbers}
              canManage={canManage}
              activation={activation}
              heading={<WizardHeading title={PAYWALL_TITLE} />}
              onContinue={onContinue}
            />
          ) : (
            <>
              <WizardHeading title={PAYWALL_TITLE} />
              {proof ? <ProofColumn proof={proof} /> : null}
              <WizardFooter>
                <span />
                <PrimaryAction onClick={onContinue}>Continue to the console</PrimaryAction>
              </WizardFooter>
            </>
          )}
        </WizardCard>
      );
      break;
    }
  }

  const [step, label] = PROGRESS[view];
  return (
    <div ref={root} className="flex w-full max-w-160 flex-col gap-4">
      <WizardProgress step={step} label={label} />
      {writing ? (
        <WriteStep context={[`Path: ${goal ?? "not chosen yet"}`, `Stopped at: ${view}`]} onBack={() => setWriting(false)} />
      ) : null}
      {/* Hidden, not unmounted, while writing: a live test keeps listening. */}
      <div hidden={writing} className="flex flex-col gap-4">
        {screen}
        <FounderNote onWrite={() => setWriting(true)} />
      </div>
    </div>
  );
}
