import { type FormEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePoll } from "../../hooks/use-poll";
import { failureCopy, sendTextFailureCopy } from "../../lib/failure";
import { sendKeyed, type SendGate } from "../../lib/send-gate";
import {
  type Arrived,
  arrivedMessage,
  plusNumber,
  replyOutcome,
  type SendOutcome,
  shortTime,
  TEST_REPLY,
} from "../../lib/setup-test";
import { listConversations, listOutbound, sendText } from "../../server/gateway";
import { Callout } from "../ui/callout";
import { BackAction, TEXT_LINK, WizardCard, WizardFooter, WizardHeading } from "../connect-wizard/wizard-frame";
import { Stepper } from "../connect-wizard/stepper";
import type { Proof } from "./activation-paywall";
import { ChatPreview } from "./chat-preview";
import { OTHER_PHONE, SelfTestQr } from "./self-test-qr";
import { Waiting } from "./waiting";

export type InboxTestProps = {
  wabaId: string;
  phoneNumberId: string;
  /** This number, as people read it. */
  phone: string;
  onBack: () => void;
  onSuccess: (proof: Proof) => void;
  now?: () => number;
};

/**
 * Path A (2.A1, 2.A1b): the operator texts their own number from another
 * phone, sees it arrive here, and answers it from here. Success is Meta's
 * delivered receipt for that reply.
 */
export function InboxTest({ wabaId, phoneNumberId, phone, onBack, onSuccess, now = Date.now }: InboxTestProps) {
  const [since] = useState(now);
  const [arrived, setArrived] = useState<Arrived | null>(null);
  const [sent, setSent] = useState<{ messageId: string; text: string; at: number } | null>(null);
  const [outcome, setOutcome] = useState<SendOutcome>({ state: "waiting" });

  usePoll(async () => {
    const res = await listConversations({ data: { wabaId, limit: 10 } });
    if (res.ok) setArrived(arrivedMessage(res.data.items, since));
  }, arrived === null);

  usePoll(async () => {
    if (!sent) return;
    const res = await listOutbound({ data: { wabaId } });
    if (!res.ok) return;
    const next = replyOutcome(res.data, sent.messageId);
    setOutcome(next);
    if (next.state === "delivered" && arrived) {
      onSuccess({
        title: plusNumber(arrived.waId),
        messages: [
          { key: "in", direction: "in", text: arrived.text, at: arrived.at },
          { key: "out", direction: "out", text: sent.text, at: next.at, delivered: true },
        ],
        note: (
          <>
            Delivered to {plusNumber(arrived.waId)} at <span className="font-mono text-xs text-foreground">{shortTime(next.at)}</span>.
          </>
        ),
      });
    }
  }, sent !== null && outcome.state === "waiting");

  if (!arrived) {
    return (
      <WizardCard>
        <WizardHeading title="Send a WhatsApp to your own number">
          Scan the code with another phone, yours or a colleague's. Your message shows up here in a few seconds.
        </WizardHeading>
        <div className="flex flex-col gap-7 sm:flex-row sm:items-start">
          <SelfTestQr phone={phone} />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <ChatPreview title="Your message" to={phone} messages={[]} placeholder="Your message will appear here" className="h-60" />
            <Waiting>
              <span className="font-semibold text-foreground">Waiting for your message.</span> This page updates on its own.
            </Waiting>
            <p className="m-0 text-[13px] leading-4.5 text-muted-foreground">{OTHER_PHONE}</p>
          </div>
        </div>
        <WizardFooter>
          <BackAction onClick={onBack} />
          <a href="/conversations" className={TEXT_LINK}>
            Skip the test and open the inbox
          </a>
        </WizardFooter>
      </WizardCard>
    );
  }

  const from = plusNumber(arrived.waId);
  return (
    <WizardCard>
      <WizardHeading title="It arrived. Now answer it.">When your reply reaches the phone, your setup is complete.</WizardHeading>
      <div className="flex flex-col gap-7 sm:flex-row sm:items-start">
        <Stepper
          className="w-full shrink-0 sm:w-57"
          steps={[
            { key: "arrived", text: "Message arrived", state: "done", aside: shortTime(arrived.at) },
            {
              key: "answer",
              text: "You answer it",
              note: sent ? undefined : "The reply is ready on the right. Send it as it is, or write your own.",
              state: sent ? "done" : "now",
              aside: sent ? shortTime(sent.at) : undefined,
            },
            { key: "reached", text: "Your reply reaches the phone", state: sent ? "now" : "next" },
          ]}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <ChatPreview
            title={from}
            to={phone}
            messages={[
              { key: "in", direction: "in", text: arrived.text, at: arrived.at },
              ...(sent ? [{ key: "out", direction: "out" as const, text: sent.text, at: sent.at }] : []),
            ]}
            className="h-50"
          />
          {sent ? (
            outcome.state === "failed" ? (
              <Callout tone="error">
                Meta did not deliver the reply{outcome.error ? ` (${outcome.error})` : ""}. Try once more from the inbox.
              </Callout>
            ) : (
              <Waiting>Waiting for the phone to confirm it got your reply.</Waiting>
            )
          ) : (
            <ReplyForm
              wabaId={wabaId}
              phoneNumberId={phoneNumberId}
              to={arrived.waId}
              onSent={(messageId, text) => setSent({ messageId, text, at: now() })}
            />
          )}
        </div>
      </div>
      <WizardFooter>
        <BackAction onClick={onBack} />
        <a href={`/conversations?waId=${encodeURIComponent(arrived.waId)}`} className={TEXT_LINK}>
          Answer from the inbox instead
        </a>
      </WizardFooter>
    </WizardCard>
  );
}

/** The one reply, prefilled, sent through the composer's own server function and send gate. */
function ReplyForm({
  wabaId,
  phoneNumberId,
  to,
  onSent,
}: {
  wabaId: string;
  phoneNumberId: string;
  to: string;
  onSent: (messageId: string, text: string) => void;
}) {
  const [text, setText] = useState(TEST_REPLY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef<SendGate>({ phase: "idle" });

  async function send(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sendKeyed(gate.current, { wabaId, phoneNumberId, to, text: body }, (data) => sendText({ data }));
      if (!res.ok) setError(failureCopy(res).detail);
      else if (!res.data.ok) setError(sendTextFailureCopy(res.data.code, res.data.detail).detail);
      else onSent(res.data.messageId, body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void send(e)} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          aria-label="Your reply"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-11 flex-1 bg-(--ghost-fill) px-3 text-sm md:text-sm"
        />
        <Button type="submit" disabled={busy || !text.trim()} className="h-11 px-4 text-[15px] leading-5 font-semibold">
          Send reply
        </Button>
      </div>
      {error ? <Callout tone="error">{error}</Callout> : null}
      <p className="m-0 pt-1 text-[13px] leading-4.5 text-muted-foreground">You can change the text. It is a real message.</p>
    </form>
  );
}
