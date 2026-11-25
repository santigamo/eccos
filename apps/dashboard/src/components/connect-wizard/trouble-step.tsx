import { useState, type ReactNode } from "react";
import { CopyIcon, OctagonXIcon, TriangleAlertIcon } from "lucide-react";
import { CopyButton } from "../dashboard/copy-button";
import { ErrorReport } from "../ui/callout";
import type { Feedback } from "../dashboard/use-embedded-signup";
import { type Trouble, RELEASE_REQUEST, closedAt } from "../../lib/connect-trouble";
import { cn } from "@/lib/utils";
import { NO_ICON_NOTE, PopupFix } from "./popup-fix";
import { Stepper, type StepperStep } from "./stepper";
import { PrimaryAction, SectionLabel, TextAction, WizardCard, WizardFooter } from "./wizard-frame";

type Tone = "error" | "warning" | "neutral";

const RAIL: Record<Tone, string> = {
  error: "border-l-destructive",
  warning: "border-l-warning",
  neutral: "border-l-(--line-strong)",
};
const LABEL: Record<Tone, string> = {
  error: "text-destructive-foreground",
  warning: "text-warning-foreground",
  neutral: "text-muted-foreground",
};
const ICON: Record<Tone, ReactNode> = {
  error: <OctagonXIcon aria-hidden="true" className="size-3.5 shrink-0" />,
  warning: <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />,
  neutral: null,
};

/** What happened, on its rail: the state word, the headline, the plain explanation. */
function Status({ tone, label, title, children }: { tone: Tone; label: string; title: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-2 border-l-2 py-0.5 pl-5", RAIL[tone])}>
      <p className={cn("m-0 flex items-center gap-2 text-[11px] leading-3.5 font-semibold tracking-wider uppercase", LABEL[tone])}>
        {ICON[tone]}
        {label}
      </p>
      <h2 tabIndex={-1} className="m-0 text-lg leading-6 font-semibold tracking-[-0.01em] text-balance text-foreground outline-none">
        {title}
      </h2>
      <p className="m-0 text-sm text-pretty text-muted-foreground">{children}</p>
    </div>
  );
}

function Steps({ steps }: { steps: StepperStep[] }) {
  return (
    <div className="flex flex-col">
      <SectionLabel>What to do</SectionLabel>
      <Stepper steps={steps} />
    </div>
  );
}

/** Self-diagnosis: each row a case the customer recognises, and its way out. */
function Cases({ label, cases }: { label: string; cases: { title: string; body: string }[] }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <ul className="m-0 list-none p-0">
        {cases.map((c, i) => (
          <li key={c.title} className={cn("flex flex-col gap-1 border-t border-border", i === cases.length - 1 ? "pt-3.5" : "py-3.5")}>
            <p className="m-0 text-[15px] leading-5 font-semibold text-foreground">{c.title}</p>
            <p className="m-0 text-sm text-muted-foreground">{c.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

const COPY_LABELS = { copy: "Copy", copied: "Copied", failed: "Copy failed" };

/** Meta's references, which its support asks for. */
function Refs({ refs }: { refs: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="font-mono text-xs text-muted-foreground">{refs}</span>
      <CopyButton
        value={refs}
        labels={COPY_LABELS}
        icon={<CopyIcon aria-hidden="true" className="size-3" />}
        variant="link"
        className="h-auto gap-1.5 px-0 py-1 text-foreground underline decoration-1 underline-offset-3"
      />
    </div>
  );
}

const PIN_CASES = [
  { title: "I know the PIN", body: "Start again and type it when Meta asks." },
  {
    title: "I forgot it, and the number is on my phone",
    body: "Open WhatsApp Business on the phone. Go to Settings, then Account, then Two-step verification. Tap Turn off, or Change PIN. Then start again.",
  },
  {
    title: "Another service set it up",
    body: "Ask them to turn off two-step verification for your number, or to give you the PIN. If they do not answer, write to me below.",
  },
];

const CLOSED_CASES = [
  { title: "I closed it by mistake", body: "No problem. Start again. Meta remembers most of what you typed." },
  {
    title: "I could not scan the square code",
    body: "Open this page on a computer, and scan with the phone that has the number. A phone cannot scan its own screen.",
  },
  {
    title: "Meta said my number does not have enough activity",
    body: "Use the number in the WhatsApp Business app as usual for about a week, then try again.",
  },
  {
    title: "Meta showed an error I did not understand",
    body: "Write to me below. Tell me which screen it was, and I will look it up.",
  },
];

const MOVE_STEPS: StepperStep[] = [
  { key: "install", text: "On your phone, install the app called WhatsApp Business.", note: "Its icon has a letter B." },
  { key: "sign-in", text: "Open it and sign in with this same number.", note: "Say yes when it offers to bring your chats." },
  {
    key: "use",
    text: "Use it as usual for about a week.",
    note: "Meta asks for some normal use before it lets a number connect.",
  },
  { key: "back", text: "Come back here." },
];

/**
 * 1.5a to 1.5e: why an attempt did not connect, in the customer's words, with
 * the one way out. Picked from the attempt's own feedback (`troubleFor`).
 */
export function TroubleStep({
  trouble,
  feedback,
  onRetry,
  onBusinessApp,
  onOtherNumber,
}: {
  trouble: Trouble;
  feedback: Feedback;
  /** Open Meta again on the same path, from this click. */
  onRetry: () => void;
  /** Open Meta again on the Business app path. */
  onBusinessApp: () => void;
  onOtherNumber: () => void;
}) {
  const [noIcon, setNoIcon] = useState(false);
  const other = <TextAction onClick={onOtherNumber}>Use a different number</TextAction>;
  const retry = (label: string, onClick = onRetry) => (
    <PrimaryAction onClick={onClick} icon={null}>
      {label}
    </PrimaryAction>
  );
  const meta = feedback.tone === "meta" ? feedback.error : null;
  const text = feedback.tone === "meta" ? "" : feedback.text;

  switch (trouble) {
    case "provider":
      return (
        <WizardCard>
          <Status tone="error" label="Not connected" title="Another provider is still holding this number">
            Meta says the number is already connected through another WhatsApp service. That is usually a chatbot, a CRM or
            an agency you used before. Only they can let it go.
          </Status>
          <Steps
            steps={[
              {
                key: "ask",
                text: "Write to that provider and ask them to release your number from their WhatsApp account.",
                extra: (
                  <CopyButton
                    value={RELEASE_REQUEST}
                    label="Copy a message you can send them"
                    variant="outline"
                    icon={<CopyIcon aria-hidden="true" className="size-3.5" />}
                    className="h-9 gap-2 px-3.5 text-sm"
                  />
                ),
              },
              { key: "wait", text: "Wait for their confirmation.", note: "It can take a day or two." },
              { key: "back", text: "Come back and click Try again.", note: "Nothing is lost here." },
            ]}
          />
          {meta ? <Refs refs={meta.refs} /> : null}
          <WizardFooter>
            {other}
            {retry("Try again")}
          </WizardFooter>
        </WizardCard>
      );
    case "regular-app":
      return (
        <WizardCard>
          <Status tone="warning" label="Not connected yet" title="This number is on regular WhatsApp, not WhatsApp Business">
            Meta can only link the Business app. Nothing is wrong with your number. It needs one move first, and your chats
            come with you.
          </Status>
          <Steps steps={MOVE_STEPS} />
          {meta ? <Refs refs={meta.refs} /> : null}
          <WizardFooter>
            {other}
            {retry("I moved it, try again", onBusinessApp)}
          </WizardFooter>
        </WizardCard>
      );
    case "pin":
      return (
        <WizardCard>
          <Status tone="warning" label="Not connected yet" title="Meta asked for a six-digit PIN">
            It is the "two-step verification" PIN of your WhatsApp number. Someone set it in the past: maybe you, maybe a
            service you used before. It is not the code Meta sends by SMS.
          </Status>
          <Cases label="Which one is you?" cases={PIN_CASES} />
          {meta ? <Refs refs={meta.refs} /> : null}
          <WizardFooter>
            {other}
            {retry("Start again")}
          </WizardFooter>
        </WizardCard>
      );
    case "popup":
      return (
        <WizardCard>
          <Status tone="warning" label="Meta did not open" title="Your browser stopped Meta's window">
            Browsers block new windows to protect you. You only need to allow it once for this site. Nothing is broken.
          </Status>
          <PopupFix />
          {noIcon ? <p className="m-0 border-l-2 border-l-(--line-strong) py-0.5 pl-5 text-sm text-muted-foreground">{NO_ICON_NOTE}</p> : null}
          <WizardFooter>
            {noIcon ? <span /> : <TextAction onClick={() => setNoIcon(true)}>I don't see that icon</TextAction>}
            {retry("Open Meta again")}
          </WizardFooter>
        </WizardCard>
      );
    case "closed": {
      const where = closedAt(feedback);
      return (
        <WizardCard>
          <Status tone="neutral" label="Not finished" title="Meta's window closed before the end">
            Nothing changed and nothing broke. Your number works exactly as before. You can start again whenever you want.
          </Status>
          <Cases label="What happened? Find yours" cases={CLOSED_CASES} />
          {where ? <p className="m-0 font-mono text-xs text-muted-foreground">{where}</p> : null}
          <WizardFooter>
            {other}
            {retry("Start again")}
          </WizardFooter>
        </WizardCard>
      );
    }
    case "meta":
      return (
        <WizardCard>
          {meta ? <ErrorReport status="Not connected" labels={COPY_LABELS} {...meta} /> : null}
          <WizardFooter>
            {other}
            {retry("Try again")}
          </WizardFooter>
        </WizardCard>
      );
    case "error":
      return (
        <WizardCard>
          <Status tone="error" label="Not connected" title="The connection did not finish">
            {text}
          </Status>
          <WizardFooter>
            {other}
            {retry("Try again")}
          </WizardFooter>
        </WizardCard>
      );
  }
}
