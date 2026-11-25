import type { ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Activation, hoursLeft } from "../../lib/activation";
import { monthlyPriceEuros } from "../../billing/plan";
import { startCheckout } from "../../server/gateway";
import { BillingError, useBillingRedirect } from "../dashboard/billing-redirect";
import { type ChatMessage, ChatPreview } from "./chat-preview";

/** The real exchange a live test observed: what the phone shows, and one line saying when it landed. */
export type Proof = { title: string; messages: ChatMessage[]; note: ReactNode };

const LABEL = "m-0 text-[11px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase";

export const PAYWALL_TITLE = "It works. Your number is live on Eccos.";

/** The exchange as the phone shows it, and when it landed. */
export function ProofColumn({ proof }: { proof: Proof }) {
  return (
    <div className="flex w-full shrink-0 flex-col gap-3 sm:w-62">
      <p className={LABEL}>The proof</p>
      <ChatPreview title={proof.title} messages={proof.messages} className="min-h-53 flex-1" />
      <p className="m-0 text-[13px] leading-4.5 text-muted-foreground">{proof.note}</p>
    </div>
  );
}

export type PaywallProps = {
  proof: Proof | null;
  /** Billable numbers: what the subscription is priced for. */
  numbers: number;
  /** The member may start the subscription (admin and above). */
  canManage: boolean;
  activation: Activation | null;
  onContinue: () => void;
};

/**
 * 2.2 / 2.3: the first success, proven with the operator's own exchange, next
 * to the price. Subscribing is the one green action; the window is a quiet link.
 * `heading` is the surface's own title element (an h2 in the wizard, the
 * dialog's title in the console).
 */
export function ActivationPaywall({ proof, numbers, canManage, activation, onContinue, heading }: PaywallProps & { heading: ReactNode }) {
  const { busy, error, leaveTo } = useBillingRedirect();
  const euros = monthlyPriceEuros(numbers);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="m-0 flex items-center gap-2 pb-1 text-[11px] leading-3.5 font-semibold tracking-wider text-foreground uppercase">
          <CheckIcon aria-hidden="true" strokeWidth={2.5} className="size-3.5" />
          It works
        </p>
        {heading}
      </div>
      <div className="flex flex-col gap-7 border-t border-border pt-6 sm:flex-row">
        {proof ? <ProofColumn proof={proof} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <p className={LABEL}>Keep it running</p>
          <p className="m-0 flex items-baseline gap-2.5">
            <span className="text-lg leading-6 font-semibold tracking-[-0.01em] text-foreground">{euros} € per month</span>
            <span className="text-sm text-muted-foreground">
              {numbers > 1 ? `for your ${numbers} numbers` : "for this number"}, + VAT
            </span>
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {["Eccos never charges per message.", "Each extra number adds 3 € per month.", "Cancel whenever you want. Your number stays yours."].map(
              (line) => (
                <li key={line} className="flex items-start gap-3 text-sm text-foreground">
                  <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
                    <CheckIcon strokeWidth={2.5} className="size-3.5" />
                  </span>
                  {line}
                </li>
              ),
            )}
          </ul>
          <div className="flex flex-col gap-3 pt-1">
            {canManage ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void leaveTo(() => startCheckout())}
                className="h-11 w-full text-[15px] leading-5 font-semibold"
              >
                Start subscription · {euros} €/month
              </Button>
            ) : (
              <p className="m-0 text-sm text-foreground">Ask an owner or admin of this workspace to start the subscription.</p>
            )}
            <BillingError error={error} />
            <p className="m-0 text-[13px] leading-4.5 text-muted-foreground">
              Not ready yet? You have {hoursLeft(activation)} hours to keep setting things up. After that, sending stops and
              messages are not passed on until you subscribe. Nothing is deleted.{" "}
              <button type="button" onClick={onContinue} className="font-medium text-foreground underline decoration-1 underline-offset-3 hover:decoration-2">
                Continue to the console
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
