import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ClockIcon, CirclePauseIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { openPortal, startCheckout, type BillingPage } from "../../server/gateway";
import type { Payment } from "../../billing/creem";
import { nextNumberNote, numberPriceEuros, tierNote } from "../../billing/plan";
import { daysLeft, longDate, timeLeft, weekdayDate, weekdayTime, windowOpen } from "../../lib/setup-window";
import { buttonVariants, Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { INLINE_LINK } from "../../ui";
import { MACHINE_CLASS } from "./plain-table";
import { BillingError, useBillingRedirect } from "./billing-redirect";

const BODY = "m-0 text-sm text-muted-foreground";
const STRONG = "font-medium text-foreground";
const MONO = "font-mono text-[13px] leading-5 text-foreground";
const CREEM_NOTE = "Opens the secure page of Creem, our payment partner.";
const CARD_NOTE = "You add your card on the secure page of Creem, our payment partner.";
const BIG = "h-11 px-5 text-[15px] leading-5";

/** Which page the workspace reads; a pure function of the stored status and the setup timers. */
export type BillingStage =
  | "unconnected"
  | "not-activated"
  | "window"
  | "active"
  | "past_due"
  | "cancelled"
  | "paused"
  | "closed"
  | "separate";

export function billingStage({ billing, phones, window }: BillingPage, now: number): BillingStage {
  switch (billing.billingStatus) {
    case "setup":
      if (phones.length === 0) return "unconnected";
      return windowOpen(window, now) ? "window" : "not-activated";
    case "open":
      // Opened by the operator with a Creem customer of its own is an ordinary subscription.
      return billing.hasCustomer ? "active" : "separate";
    default:
      return billing.billingStatus;
  }
}

const SUBSCRIBED: BillingStage[] = ["active", "past_due", "cancelled"];

/** A Creem transaction status in the console's words. */
export function paymentStatusWord(status: string): { word: string; warn: boolean } {
  switch (status) {
    case "paid":
      return { word: "Paid", warn: false };
    case "pending":
      return { word: "Pending", warn: false };
    case "refunded":
      return { word: "Refunded", warn: false };
    case "partialRefund":
      return { word: "Partly refunded", warn: false };
    case "chargedBack":
      return { word: "Charged back", warn: true };
    case "canceled":
    case "void":
      return { word: "Cancelled", warn: false };
    default:
      return { word: "Not paid", warn: true };
  }
}

function money(payment: Payment): string {
  const amount = (payment.amountCents / 100).toFixed(2);
  return payment.currency === "EUR" ? `${amount} €` : `${amount} ${payment.currency}`;
}

/** The page under the header, free of router state so it renders directly in tests. */
export function BillingView({ page, now }: { page: BillingPage; now: number }) {
  const stage = billingStage(page, now);
  return (
    <div className="flex flex-col">
      <StatusBlock page={page} stage={stage} now={now} />
      <div className="h-8 shrink-0" />
      <PlanSection page={page} stage={stage} />
      {SUBSCRIBED.includes(stage) ? <NextChargeSection page={page} stage={stage} /> : null}
      {page.canManage ? <ManageSections page={page} stage={stage} /> : stage === "separate" ? null : <MemberSection />}
    </div>
  );
}

function ManageSections({ page, stage }: { page: BillingPage; stage: BillingStage }) {
  if (stage === "separate") return null;
  if (stage === "paused") return <AfterPaymentSection />;
  if (!SUBSCRIBED.includes(stage)) {
    return (
      <Section title="Card and invoices" description="Nothing to show yet.">
        <p className={BODY}>
          <span className={STRONG}>They appear here once you subscribe.</span> You add your card on the secure page of
          Creem, our payment partner. Eccos never sees or stores it.
        </p>
      </Section>
    );
  }
  return (
    <>
      <PaymentMethodSection />
      <InvoicesSection payments={page.payments} />
      <ChangeSection page={page} stage={stage} />
    </>
  );
}

function Section({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  const id = `billing-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 border-t border-(--line) py-7 last:pb-0 lg:flex-row lg:gap-12">
      <div className="flex flex-col gap-2 lg:w-75 lg:shrink-0">
        <h2 id={id} className="m-0 text-[15px] leading-5 font-semibold text-foreground">
          {title}
        </h2>
        <p className={BODY}>{description}</p>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
    </section>
  );
}

function PortalButton({ children, variant = "outline", big }: { children: string; variant?: "outline" | "default"; big?: boolean }) {
  const { busy, error, leaveTo } = useBillingRedirect();
  return (
    <div className="shrink-0">
      <Button
        type="button"
        variant={variant}
        disabled={busy}
        onClick={() => void leaveTo(() => openPortal())}
        className={big ? cn(BIG, variant === "default" && "font-semibold") : "h-9 px-3.5 text-sm"}
      >
        {children}
        <ExternalLinkIcon aria-hidden="true" data-icon="inline-end" />
      </Button>
      <BillingError error={error} />
    </div>
  );
}

function CheckoutButton({ euros }: { euros: number }) {
  const { busy, error, leaveTo } = useBillingRedirect();
  return (
    <div className="shrink-0">
      <Button type="button" disabled={busy} onClick={() => void leaveTo(() => startCheckout())} className={cn(BIG, "font-semibold")}>
        Start subscription · {euros} €/month
      </Button>
      <BillingError error={error} />
    </div>
  );
}

const TONES = {
  neutral: { rail: "border-l-(--line-strong)", ink: "text-foreground" },
  warning: { rail: "border-l-warning", ink: "text-warning-foreground" },
  paused: { rail: "border-l-destructive", ink: "text-destructive-foreground" },
};

function StatusBlock({ page, stage, now }: { page: BillingPage; stage: BillingStage; now: number }) {
  const { billing, window, charge, canManage } = page;
  const euros = billing.monthlyEuros;
  const ends = charge?.periodEndsAt ? longDate(charge.periodEndsAt) : null;
  let tone: keyof typeof TONES = "neutral";
  let icon: ReactNode = null;
  let label: string;
  let count: string | null = null;
  let title: string;
  let body: ReactNode;
  let actions: ReactNode = null;

  switch (stage) {
    case "unconnected":
      icon = <ClockIcon />;
      label = "Not set up yet";
      title = "Connect your first number";
      body = "Your first number works without a subscription. You subscribe once a message has gone through it.";
      actions = <FinishSetup />;
      break;
    case "not-activated":
      icon = <ClockIcon />;
      label = "Not set up yet";
      count = window.pausesAt && window.pausesAt > now ? daysLeft(window.pausesAt - now) : null;
      title = "Your number is connected, but no message has gone through yet";
      body = (
        <>
          Finish the setup and send or receive one message through Eccos.
          {window.pausesAt ? (
            <>
              {" "}If that has not happened by <span className={STRONG}>{weekdayDate(window.pausesAt)}</span>, the number
              is paused until you subscribe.
            </>
          ) : null}{" "}
          Finishing the setup does not need a card.
        </>
      );
      actions = (
        <>
          <FinishSetup />
          <SecondaryCheckout />
          <Note lines={["Subscribing now is optional.", "You can also do it after your first message."]} />
        </>
      );
      break;
    case "window":
      icon = <ClockIcon />;
      label = "Setup window";
      count = timeLeft((window.pausesAt ?? now) - now);
      title = "Your number works. Subscribe to keep it running.";
      body = (
        <>
          Your first message went through on {weekdayTime(window.activatedAt ?? now)}. The setup window ends on{" "}
          <span className={STRONG}>{weekdayTime(window.pausesAt ?? now)}</span> and cannot be made longer. After that,
          sending stops and messages are not passed on to your tool until you subscribe. Nothing is deleted.
        </>
      );
      actions = (
        <>
          <CheckoutButton euros={euros} />
          <Note lines={[CARD_NOTE]} />
        </>
      );
      break;
    case "active": {
      icon = <CheckIcon />;
      label = "Active";
      title = canManage ? "Your subscription is active. Everything is running." : "The subscription is active. Everything is running.";
      const next = charge?.nextChargeAt ? ` Next charge on ${longDate(charge.nextChargeAt)}.` : "";
      body = `${billing.numbers} ${billing.numbers === 1 ? "number" : "numbers"}, ${euros} € per month + VAT.${next}`;
      break;
    }
    case "past_due":
      tone = "warning";
      icon = <TriangleAlertIcon />;
      label = "Payment failed";
      title = "Your last payment did not go through";
      body = (
        <>
          We could not charge your card. We will try again in a few days.{" "}
          <span className={STRONG}>Nothing is paused: your numbers keep working.</span> Update the card so the next try
          goes through.
        </>
      );
      actions = (
        <>
          <PortalButton variant="default" big>
            Update card
          </PortalButton>
          <Note lines={[CREEM_NOTE]} />
        </>
      );
      break;
    case "cancelled":
      label = "Cancelled";
      title = ends ? `Cancelled. Everything works until ${ends}.` : "Cancelled. Everything works until the period ends.";
      body = `Until then nothing changes. ${ends ? `On ${ends}` : "When it ends"} your numbers are paused: sending stops and messages are not passed on to your tool. New messages are still saved, and nothing is deleted.`;
      actions = (
        <>
          <PortalButton variant="default" big>
            Keep my subscription
          </PortalButton>
          <Note lines={["Changed your mind? You can undo it until shortly before that date.", CREEM_NOTE]} />
        </>
      );
      break;
    case "paused":
    case "closed":
      tone = "paused";
      icon = <CirclePauseIcon />;
      label = stage === "paused" ? "Paused" : "No subscription";
      title = stage === "paused" ? "Your number is paused. Nothing was deleted." : "There is no active subscription. Nothing was deleted.";
      body = (
        <>
          {window.pausesAt && window.pausesAt <= now ? <>The setup window ended on {weekdayTime(window.pausesAt)}.<br /></> : null}
          <span className={STRONG}>Stopped for now:</span> sending messages, and passing messages on to your tool.
          <br />
          <span className={STRONG}>Still working:</span> new messages are saved, you can read everything here, and your
          number stays registered with Meta.
        </>
      );
      actions = (
        <>
          <CheckoutButton euros={euros} />
          <Note lines={["Everything goes live again the moment you subscribe.", CARD_NOTE]} />
        </>
      );
      break;
    case "separate":
      label = "Billed separately";
      title = "This workspace is not charged here";
      body = (
        <>
          The organisation that set up this workspace pays for it. You can connect numbers and use everything. There is
          nothing to pay or to set up on this page.
          <br />
          A question about the bill? Ask whoever invited you.
        </>
      );
      break;
  }

  return (
    <div className={cn("flex flex-col gap-2 border-l-2 py-0.5 pl-5", TONES[tone].rail)}>
      <div className="flex items-center gap-2">
        {icon ? <span aria-hidden="true" className={cn("flex [&_svg]:size-3.5", TONES[tone].ink)}>{icon}</span> : null}
        <p className={cn("m-0 text-[11px] leading-3.5 font-semibold tracking-[0.08em] uppercase", stage === "cancelled" ? "text-muted-foreground" : TONES[tone].ink)}>
          {label}
          {canManage || stage === "separate" ? "" : " · view only"}
        </p>
        {count ? <span className="font-mono text-xs font-medium text-foreground">{count}</span> : null}
      </div>
      <p className="m-0 text-lg leading-6 font-semibold tracking-[-0.01em] text-foreground">{title}</p>
      <p className={cn(BODY, "max-w-170")}>
        {canManage || stage === "separate" ? body : "Only owners and admins can change billing. Ask an owner or admin of this workspace."}
      </p>
      {canManage && actions ? <div className="flex flex-wrap items-center gap-4 pt-2">{actions}</div> : null}
    </div>
  );
}

function FinishSetup() {
  return (
    <Link to="/numbers" className={cn(buttonVariants(), BIG, "font-semibold")}>
      Finish setup
    </Link>
  );
}

function SecondaryCheckout() {
  const { busy, error, leaveTo } = useBillingRedirect();
  return (
    <div className="shrink-0">
      <Button type="button" variant="outline" disabled={busy} onClick={() => void leaveTo(() => startCheckout())} className={BIG}>
        Start subscription
      </Button>
      <BillingError error={error} />
    </div>
  );
}

function Note({ lines }: { lines: string[] }) {
  return (
    <p className="m-0 text-[13px] leading-4.5 text-muted-foreground">
      {lines.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </p>
  );
}

function PlanSection({ page, stage }: { page: BillingPage; stage: BillingStage }) {
  const { billing, phones, canManage } = page;
  const separate = stage === "separate";
  const n = phones.length;
  return (
    <Section
      title="Plan"
      description={separate ? "The numbers connected to this workspace." : "You pay for each connected number. Eccos never charges per message."}
    >
      {n > 0 ? (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-(--line)">
              <th scope="col" className={cn(MACHINE_CLASS, "w-55 pb-2.5 font-medium")}>Number</th>
              <th scope="col" className={cn(MACHINE_CLASS, "pb-2.5 font-medium")}>Counted as</th>
              <th scope="col" className={cn(MACHINE_CLASS, "w-40 pb-2.5 text-right font-medium")}>Per month</th>
            </tr>
          </thead>
          <tbody>
            {phones.map((phone, index) => {
              const price = numberPriceEuros(index, n);
              return (
                <tr key={phone} className={cn("border-b", index === n - 1 && !separate ? "border-(--line-strong)" : "border-(--line)")}>
                  <td className={cn(MONO, "py-3.5")}>{phone}</td>
                  <td className="py-3.5 text-sm text-muted-foreground">{index === 0 ? "First number" : "Extra number"}</td>
                  <td className={cn(MONO, "py-3.5 text-right")}>
                    {separate ? "Billed separately" : price === null ? "Included" : `${price} €`}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {separate ? null : (
            <tfoot>
              <tr>
                <th scope="row" className="pt-3.5 text-[15px] leading-5 font-semibold text-foreground" colSpan={2}>
                  Total per month
                </th>
                <td className="pt-3.5 text-right text-[15px] leading-5 font-semibold text-foreground">
                  {billing.monthlyEuros} € <span className="font-normal text-muted-foreground">+ VAT</span>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-6 pt-1">
        <p className="m-0 flex-1 text-[13px] leading-5 text-muted-foreground">
          {separate ? (
            "Adding a number does not create a charge on this page."
          ) : (
            <>
              <span className="block text-foreground">{nextNumberNote(n)}</span>
              {billing.canAddNumber || n === 0 ? tierNote(n) : "A second number needs the subscription first."}
            </>
          )}
        </p>
        {canManage && billing.canAddNumber && n > 0 && !separate ? (
          <Link to="/numbers" className={cn(buttonVariants({ variant: "outline" }), "h-9 px-3.5 text-sm")}>
            Add a number
          </Link>
        ) : null}
      </div>
    </Section>
  );
}

function LabelRow({ label, children, first }: { label: string; children: ReactNode; first?: boolean }) {
  return (
    <div className={cn("flex items-center gap-4", first ? "border-b border-(--line) pb-3.5" : "pt-3.5")}>
      <dt className={cn(MACHINE_CLASS, "w-55 shrink-0")}>{label}</dt>
      <dd className="m-0 flex-1 text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}

function NextChargeSection({ page, stage }: { page: BillingPage; stage: BillingStage }) {
  const next = page.charge?.nextChargeAt;
  const ends = page.charge?.periodEndsAt;
  const amount = (
    <>
      <span className={MONO}>{page.billing.monthlyEuros} €</span> plus VAT
    </>
  );
  if (stage === "cancelled") {
    return (
      <Section title="Next charge" description="You cancelled, so there are no more charges.">
        <dl className="m-0 flex flex-col">
          <LabelRow label="Date" first>
            <span className={STRONG}>{ends ? `None. The subscription ends on ${longDate(ends)}` : "None"}</span>
          </LabelRow>
          <LabelRow label="Amount">Nothing more will be charged</LabelRow>
        </dl>
      </Section>
    );
  }
  const retrying = stage === "past_due";
  return (
    <Section
      title="Next charge"
      description={retrying ? "A failed payment is tried again on its own. Nothing is paused meanwhile." : "Charged once a month, on the same day."}
    >
      <dl className="m-0 flex flex-col">
        <LabelRow label="Date" first>
          {retrying ? (
            <span className={STRONG}>We try again in a few days</span>
          ) : next ? (
            <span className={MONO}>{longDate(next)}</span>
          ) : (
            "Shown on the secure page of Creem"
          )}
        </LabelRow>
        <LabelRow label="Amount">{amount}</LabelRow>
      </dl>
    </Section>
  );
}

function PaymentMethodSection() {
  return (
    <Section title="Payment method" description="Eccos never sees or stores your card number.">
      <div className="flex flex-wrap items-center gap-4">
        <dl className="m-0 flex flex-1 items-center gap-4">
          <dt className={cn(MACHINE_CLASS, "w-55 shrink-0")}>Card</dt>
          <dd className="m-0 text-sm font-medium text-foreground">Your card is kept by Creem</dd>
        </dl>
        <PortalButton>Update card</PortalButton>
      </div>
      <p className="m-0 text-[13px] leading-4.5 text-muted-foreground lg:text-right">{CREEM_NOTE}</p>
    </Section>
  );
}

function InvoicesSection({ payments }: { payments: Payment[] | null }) {
  return (
    <Section title="Invoices" description="One invoice for every payment, for your accountant.">
      {payments === null ? null : payments.length === 0 ? (
        <p className={BODY}>No payments yet.</p>
      ) : (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-(--line)">
              <th scope="col" className={cn(MACHINE_CLASS, "w-55 pb-2.5 font-medium")}>Date</th>
              <th scope="col" className={cn(MACHINE_CLASS, "pb-2.5 font-medium")}>Status</th>
              <th scope="col" className={cn(MACHINE_CLASS, "w-40 pb-2.5 text-right font-medium")}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => {
              const status = paymentStatusWord(payment.status);
              return (
                <tr key={payment.id} className="border-b border-(--line)">
                  <td className={cn(MONO, "py-3.5")}>{longDate(payment.at)}</td>
                  <td className={cn("py-3.5 text-sm", status.warn ? "font-medium text-warning-foreground" : "text-foreground")}>
                    {status.word}
                  </td>
                  <td className={cn(MONO, "py-3.5 text-right")}>{money(payment)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center justify-between gap-6">
        <p className="m-0 flex-1 text-[13px] leading-4.5 text-muted-foreground">
          The PDF files are on the secure page of Creem, our payment partner. You can add your company name and tax
          number there.
        </p>
        <PortalButton>Download invoices</PortalButton>
      </div>
    </Section>
  );
}

const PRICE_FOLLOWS = (
  <p className={BODY}>
    <span className={STRONG}>The price follows your numbers on its own.</span> Connect a number and it goes up. Remove
    one and it goes down from the next charge. There is no plan to pick.
  </p>
);

function ChangeSection({ page, stage }: { page: BillingPage; stage: BillingStage }) {
  const description = "Owners and admins can change billing. Other members can only look.";
  if (stage === "cancelled") {
    return (
      <Section title="Price changes" description={description}>
        {PRICE_FOLLOWS}
      </Section>
    );
  }
  const until = page.charge?.nextChargeAt ? `until ${longDate(page.charge.nextChargeAt)}` : "until the period ends";
  return (
    <Section title="Change or cancel" description={description}>
      {PRICE_FOLLOWS}
      <div className="flex flex-wrap items-start justify-between gap-6 border-t border-(--line) pt-5">
        <p className={cn(BODY, "flex-1")}>
          <span className={STRONG}>If you cancel</span>, everything keeps running {until}. After that your numbers are
          paused. Nothing is deleted, and you can come back whenever you want.
        </p>
        <PortalButton>Cancel subscription</PortalButton>
      </div>
    </Section>
  );
}

function AfterPaymentSection() {
  return (
    <Section title="After you subscribe" description="Your stored messages wait for your decision.">
      <p className={BODY}>
        <span className={STRONG}>Everything goes live again at once.</span> The messages stored meanwhile then wait on{" "}
        <Link to="/numbers" className={INLINE_LINK}>
          Numbers
        </Link>
        , and you choose whether to pass them on. If your tool answers customers on its own, they may get late replies,
        so nothing is sent until you click.
      </p>
    </Section>
  );
}

function MemberSection() {
  return (
    <Section title="Card and invoices" description="Kept for owners and admins.">
      <p className={BODY}>
        <span className={STRONG}>You cannot see the card, the invoices or the option to cancel.</span> If you need an
        invoice or want to change something, ask an owner or admin.
      </p>
    </Section>
  );
}
