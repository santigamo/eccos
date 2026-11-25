import { Link2OffIcon, SmartphoneIcon, UserRoundIcon } from "lucide-react";
import { CopyButton } from "../dashboard/copy-button";
import { CONNECT_RETURN_PATH } from "../../server/gateway";
import { PrimaryAction, Rail, SectionLabel, WizardCard, WizardFooter, WizardHeading } from "./wizard-frame";

const NEEDS = [
  {
    icon: UserRoundIcon,
    title: "A Facebook account",
    body: "Your personal one is fine. Meta owns WhatsApp and uses it to know who you are. Nothing gets posted.",
  },
  {
    icon: SmartphoneIcon,
    title: "The phone with the number, next to you",
    body: "Meta will ask you to scan a code with it, or will send it a code by SMS or call.",
  },
  {
    icon: Link2OffIcon,
    title: "A number that no other WhatsApp service is using",
    body: "Did a chatbot, a CRM or an agency connect this number before? Ask them to release it first. If you only use it on your phone, you are fine.",
  },
];

/** 1.1: what to have at hand, and on a phone, why a computer goes better. */
export function ReadyStep({ onContinue }: { onContinue: () => void }) {
  return (
    <WizardCard>
      <WizardHeading title="Let's connect your WhatsApp number">
        It takes about five minutes. You do not need a card.
      </WizardHeading>
      <Rail tone="warning" className="gap-2 pl-4 sm:hidden">
        <p className="m-0 text-[15px] leading-5 font-semibold text-foreground">This goes better on a computer</p>
        <p className="m-0 text-sm text-muted-foreground">
          If the number is on this phone, Meta shows a square code to scan with it. A phone cannot scan its own screen.
        </p>
        <CopyButton
          value={typeof window === "undefined" ? CONNECT_RETURN_PATH : `${window.location.origin}${CONNECT_RETURN_PATH}`}
          label="Copy the link to open there"
          variant="link"
          className="h-auto self-start px-0 py-0 text-sm font-medium text-foreground underline decoration-1 underline-offset-3"
        />
      </Rail>
      <div>
        <SectionLabel>Have these three things ready</SectionLabel>
        <ul className="m-0 list-none p-0">
          {NEEDS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className={i === NEEDS.length - 1 ? "flex items-start gap-4 border-t border-border pt-4" : "flex items-start gap-4 border-t border-border py-4"}>
              <span aria-hidden="true" className="flex h-5 w-6 shrink-0 items-center justify-center text-foreground">
                <Icon className="size-4.5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="m-0 text-[15px] leading-5 font-semibold text-foreground">{title}</p>
                <p className="m-0 text-sm text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <WizardFooter>
        <p className="m-0 text-center text-[13px] leading-4.5 text-muted-foreground sm:text-left">
          Your number and your Meta account stay yours.
        </p>
        <PrimaryAction onClick={onContinue}>
          I have them, continue<span className="sm:hidden">&nbsp;here</span>
        </PrimaryAction>
      </WizardFooter>
    </WizardCard>
  );
}
