import { BackAction, WizardCard, WizardFooter, WizardHeading } from "../connect-wizard/wizard-frame";
import { ChoiceList } from "./choice-list";
import { type Tool, TOOLS } from "./tool-guides";

/** 2.B1: which tool gets the messages, so the next screen shows its exact clicks. */
export function ToolPickStep({ onPick, onBack }: { onPick: (tool: Tool) => void; onBack: () => void }) {
  return (
    <WizardCard>
      <WizardHeading title="Which tool should get your messages?">We will show you the exact clicks for it.</WizardHeading>
      <ChoiceList choices={TOOLS} onPick={onPick} />
      <WizardFooter>
        <BackAction onClick={onBack} />
        <p className="m-0 text-sm text-muted-foreground">You can change tool later, in Webhooks.</p>
      </WizardFooter>
    </WizardCard>
  );
}
