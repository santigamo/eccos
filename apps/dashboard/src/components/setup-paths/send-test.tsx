import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePoll } from "../../hooks/use-poll";
import { friendlyFailure, sendTestFailureCopy } from "../../lib/failure";
import { sendKeyed, type SendGate } from "../../lib/send-gate";
import { digitsOf, plusNumber, type SendOutcome, sendToOutcome, shortTime } from "../../lib/setup-test";
import { listOutbound, sendTemplateTest } from "../../server/gateway";
import { sendSnippet, SendSnippet } from "../dashboard/api-keys";
import { Callout } from "../ui/callout";
import { Stepper } from "../connect-wizard/stepper";
import { BackAction, WizardCard, WizardFooter, WizardHeading } from "../connect-wizard/wizard-frame";
import type { Proof } from "./activation-paywall";
import { CopyLink } from "./self-test-qr";
import { Waiting } from "./waiting";

/** Meta's sample template, there on every new WABA: the one send that needs no approval wait. */
const HELLO_WORLD = { templateName: "hello_world", languageCode: "en_US" };

/**
 * 2.C2: the key once, the operator's own phone, and a copy-paste send. Success
 * is Meta's delivered receipt on any send to that phone since this screen
 * opened, from their terminal or from the button here.
 */
export function SendTest({
  wabaId,
  phoneNumberId,
  apiKey,
  gatewayOrigin,
  onBack,
  onSuccess,
  now = Date.now,
}: {
  wabaId: string;
  phoneNumberId: string;
  apiKey: string;
  gatewayOrigin: string | null;
  onBack: () => void;
  onSuccess: (proof: Proof) => void;
  now?: () => number;
}) {
  const [since] = useState(now);
  const [to, setTo] = useState("");
  const [outcome, setOutcome] = useState<SendOutcome>({ state: "waiting" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef<SendGate>({ phase: "idle" });
  const field = useId();
  const digits = digitsOf(to);
  const valid = digits.length >= 5 && digits.length <= 15;
  const snippet = { wabaId, gatewayOrigin, apiKey, to: valid ? digits : undefined };

  usePoll(async () => {
    const res = await listOutbound({ data: { wabaId } });
    if (!res.ok) return;
    const next = sendToOutcome(res.data, digits, since);
    setOutcome(next);
    if (next.state === "delivered") {
      onSuccess({
        title: plusNumber(digits),
        messages: [{ key: "out", direction: "out", text: "Hello World", at: next.at, delivered: true }],
        note: (
          <>
            Delivered to {plusNumber(digits)} at <span className="font-mono text-xs text-foreground">{shortTime(next.at)}</span>.
          </>
        ),
      });
    }
  }, valid && outcome.state !== "delivered");

  async function sendHere() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = { wabaId, phoneNumberId, to: digits, ...HELLO_WORLD };
      const res = await sendKeyed(gate.current, payload, (data) => sendTemplateTest({ data }));
      if (!res.ok) setError(friendlyFailure(res, "We couldn't send the test. Try again in a moment."));
      else if (!res.data.ok) setError(sendTestFailureCopy(res.data.code, null).detail);
    } finally {
      setBusy(false);
    }
  }

  return (
    <WizardCard>
      <WizardHeading title="Send a test to your own phone">
        Three steps. When the message reaches your phone, your setup is complete.
      </WizardHeading>
      <Stepper
        steps={[
          {
            key: "key",
            text: "Copy your key now.",
            note: "We show it only once.",
            extra: (
              <div className="flex h-11 items-center justify-between gap-3 border border-(--line-strong) px-3.5">
                <span className="min-w-0 truncate font-mono text-[13px] text-foreground">{apiKey}</span>
                <CopyLink value={apiKey} />
              </div>
            ),
          },
          {
            key: "phone",
            text: <label htmlFor={field}>Type your own phone number, with country code.</label>,
            extra: (
              <Input
                id={field}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+34 600 111 222"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-11 bg-(--ghost-fill) px-3.5 text-sm md:text-sm"
              />
            ),
          },
          {
            key: "example",
            text: (
              <span className="flex w-full items-start justify-between gap-3">
                <span>Paste this example into a terminal, or pass it to your developer.</span>
                <CopyLink value={sendSnippet(snippet)} label="Copy example" />
              </span>
            ),
            note: "It sends Meta's sample message, Hello World.",
            extra: <SendSnippet {...snippet} />,
          },
        ]}
      />
      {outcome.state === "failed" ? (
        <Callout tone="error">Meta did not deliver it{outcome.reason ? `: ${outcome.reason}` : ""}. Check the number and send again.</Callout>
      ) : valid ? (
        <div className="border-t border-border pt-4">
          <Waiting>
            <span className="text-[15px] leading-5 font-semibold text-foreground">Waiting for the message to reach your phone</span>
          </Waiting>
        </div>
      ) : null}
      {error ? <Callout tone="error">{error}</Callout> : null}
      <WizardFooter>
        <BackAction onClick={onBack} />
        <Button
          type="button"
          variant="outline"
          disabled={!valid || busy}
          onClick={() => void sendHere()}
          className="h-12 w-full px-4 text-sm font-medium sm:h-11 sm:w-auto"
        >
          No terminal? Send it from here
        </Button>
      </WizardFooter>
    </WizardCard>
  );
}
