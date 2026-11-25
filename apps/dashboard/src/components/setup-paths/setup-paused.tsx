import { WizardCard, WizardHeading } from "../connect-wizard/wizard-frame";

/** /setup while sends are paused: a live test cannot pass, so none is offered. The pause banner above carries the CTA. */
export function SetupPaused() {
  return (
    <div className="flex w-full max-w-160 flex-col gap-4">
      <WizardCard>
        <WizardHeading title="Subscribe to resume, then test">
          Sending and forwarding are paused, so a live test cannot pass yet. Once the subscription is active, come back
          here and test your setup.
        </WizardHeading>
      </WizardCard>
    </div>
  );
}
