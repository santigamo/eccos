import { CheckIcon, CodeXmlIcon, InboxIcon, PlugIcon } from "lucide-react";
import { WizardCard, WizardFooter, WizardHeading } from "../connect-wizard/wizard-frame";
import { type Choice, ChoiceList } from "./choice-list";

export type Goal = "inbox" | "tool" | "software";

const GOALS: Choice<Goal>[] = [
  {
    id: "inbox",
    icon: InboxIcon,
    title: "Just answer from Eccos",
    detail: "Read and reply to your WhatsApp chats here, from any computer. Nothing else to set up.",
  },
  {
    id: "tool",
    icon: PlugIcon,
    title: "Connect it to my tool",
    detail: "Every new message goes to Make, n8n, Zapier or your own system, the moment it arrives.",
  },
  {
    id: "software",
    icon: CodeXmlIcon,
    title: "Send from my software",
    detail: "Your program sends WhatsApp messages through Eccos. Best with a developer at hand.",
  },
];

/** 2.1: the number is connected; pick the first thing to do with it. */
export function GoalStep({ phone, onPick }: { phone: string; onPick: (goal: Goal) => void }) {
  return (
    <WizardCard>
      <div className="flex flex-col gap-2">
        <p className="m-0 flex items-center gap-2 pb-1 text-[11px] leading-3.5 font-semibold tracking-wider text-foreground uppercase">
          <CheckIcon aria-hidden="true" strokeWidth={2.5} className="size-3.5" />
          Connected
          <span className="font-mono text-xs font-normal tracking-normal text-muted-foreground normal-case">{phone}</span>
        </p>
        <WizardHeading title="Your number is connected. What do you want to do first?">
          Pick one to start. You can add the others later.
        </WizardHeading>
      </div>
      <ChoiceList choices={GOALS} onPick={onPick} />
      <WizardFooter>
        <p className="m-0 text-sm text-muted-foreground">Not sure? Start with the first one. It takes one minute.</p>
      </WizardFooter>
    </WizardCard>
  );
}
