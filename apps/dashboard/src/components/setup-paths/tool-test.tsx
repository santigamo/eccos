import { useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { usePoll } from "../../hooks/use-poll";
import { forwardOutcome, type ForwardOutcome, plusNumber, shortTime } from "../../lib/setup-test";
import { listInbound } from "../../server/gateway";
import { Stepper } from "../connect-wizard/stepper";
import {
  BackAction,
  PrimaryAction,
  Rail,
  SectionLabel,
  TextAction,
  WizardCard,
  WizardFooter,
  WizardHeading,
} from "../connect-wizard/wizard-frame";
import type { Proof } from "./activation-paywall";
import { OTHER_PHONE, SelfTestQr } from "./self-test-qr";
import type { ToolGuide } from "./tool-guides";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Path B's live test (2.B3), and its failure (2.B4). Success is the first
 * message written since the address was saved being forwarded with a 2xx:
 * `deliveries.status = delivered` on its batch. A refusal is that batch's
 * `last_error` ("subscriber returned 404").
 */
export function ToolTest({
  guide,
  wabaId,
  phone,
  savedAt,
  onChangeAddress,
  onBack,
  onSuccess,
  now = Date.now,
}: {
  guide: ToolGuide;
  wabaId: string;
  phone: string;
  savedAt: number;
  onChangeAddress: () => void;
  onBack: () => void;
  onSuccess: (proof: Proof) => void;
  now?: () => number;
}) {
  const [since, setSince] = useState(savedAt);
  const [outcome, setOutcome] = useState<ForwardOutcome>({ state: "waiting" });
  const name = capital(guide.name);

  usePoll(async () => {
    const res = await listInbound({ data: { wabaId, limit: 20 } });
    if (!res.ok) return;
    const next = forwardOutcome(res.data, since);
    setOutcome(next);
    if (next.state === "accepted") {
      onSuccess({
        title: next.message.from ? plusNumber(next.message.from) : "Your message",
        messages: [{ key: "in", direction: "in", text: next.message.text || "Message", at: next.message.at }],
        note: (
          <>
            {name} accepted it at <span className="font-mono text-xs text-foreground">{shortTime(next.at)}</span>.
          </>
        ),
      });
    }
  }, outcome.state === "waiting" || outcome.state === "arrived");

  if (outcome.state === "refused") {
    const code = outcome.httpStatus === null ? "" : ` (${outcome.httpStatus})`;
    return (
      <WizardCard>
        <Rail tone="warning" className="gap-4">
          <div className="flex flex-col gap-2">
            <p className="m-0 flex items-center gap-2 text-[11px] leading-3.5 font-semibold tracking-wider text-warning-foreground uppercase">
              <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
              Not received yet
            </p>
            <WizardHeading title={`Your message arrived, but ${guide.name} did not accept it`}>
              {name} answered with an error{code}. Most often the address was copied incompletely, or the {guide.owner} is
              switched off. Your message is safe in Eccos.
            </WizardHeading>
          </div>
          <p className="m-0 font-mono text-xs text-muted-foreground">
            {outcome.httpStatus === null ? outcome.error : `${name} answered ${outcome.httpStatus}`} · {clock(outcome.at)}
          </p>
        </Rail>
        <div>
          <SectionLabel>What to do</SectionLabel>
          <Stepper
            steps={[
              { key: "fix", text: guide.fix },
              {
                key: "again",
                text:
                  guide.name === "your system"
                    ? "Check the address with your developer and paste it here."
                    : `Copy the address again in ${guide.name} and paste it here.`,
                note: "Check that nothing is missing at the end.",
              },
            ]}
          />
        </div>
        <WizardFooter>
          <TextAction onClick={onChangeAddress}>Change the address</TextAction>
          <PrimaryAction
            icon={null}
            onClick={() => {
              setSince(now());
              setOutcome({ state: "waiting" });
            }}
          >
            Try again
          </PrimaryAction>
        </WizardFooter>
      </WizardCard>
    );
  }

  const arrived = outcome.state === "arrived" || outcome.state === "accepted";
  return (
    <WizardCard>
      <WizardHeading title="Now send a WhatsApp to your number">
        Scan the code with another phone and tap send. We show you here the moment {guide.name} receives it.
      </WizardHeading>
      <div className="flex flex-col gap-7 sm:flex-row sm:items-start">
        <SelfTestQr phone={phone} footnote={OTHER_PHONE} />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <p className="m-0 text-[11px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase">Live</p>
          <Stepper
            steps={[
              { key: "saved", text: "Address saved", state: "done", aside: shortTime(savedAt) },
              arrived
                ? { key: "message", text: "Message arrived", state: "done", aside: shortTime(outcome.message.at) }
                : { key: "message", text: "Waiting for a message on your number", note: guide.listen, state: "now" },
              {
                key: "confirmed",
                text: `${name} confirms it received it`,
                note: "That completes your setup.",
                state: arrived ? "now" : "next",
              },
            ]}
          />
          <output className="block border-t border-border pt-3 text-[13px] leading-4.5 text-muted-foreground">
            {arrived ? `Message arrived. Waiting for ${guide.name} to answer.` : "This page updates on its own."}
          </output>
        </div>
      </div>
      <WizardFooter>
        <BackAction onClick={onBack} />
      </WizardFooter>
    </WizardCard>
  );
}
