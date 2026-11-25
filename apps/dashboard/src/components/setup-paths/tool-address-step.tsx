import { type FormEvent, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { failureCopy } from "../../lib/failure";
import { withStepUp } from "../../lib/step-up";
import { setSubscriberConfig } from "../../server/gateway";
import { Callout } from "../ui/callout";
import { Stepper } from "../connect-wizard/stepper";
import { BackAction, PrimaryAction, Rail, WizardCard, WizardFooter, WizardHeading } from "../connect-wizard/wizard-frame";
import type { ToolGuide } from "./tool-guides";

/**
 * 2.B2: the tool's clicks, then its address saved as this WABA's forwarding
 * target, through the same server function /webhooks uses. The secret is left
 * as it is: an untouched secret means keep.
 */
export function ToolAddressStep({
  guide,
  wabaId,
  initialUrl = "",
  onSaved,
  onBack,
}: {
  guide: ToolGuide;
  wabaId: string;
  initialUrl?: string;
  onSaved: (url: string) => void;
  onBack: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useId();
  const valid = /^https:\/\/\S+$/.test(url.trim());

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const target = url.trim();
      const res = await withStepUp(() => setSubscriberConfig({ data: { url: target, wabaId } }));
      if (res.ok) onSaved(target);
      else setError(failureCopy(res).detail);
    } finally {
      setBusy(false);
    }
  }

  const paste = (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2">
      <Input
        id={field}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder={guide.placeholder}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-invalid={url.trim() !== "" && !valid}
        aria-describedby={`${field}-hint`}
        className="h-11 bg-(--ghost-fill) px-3.5 font-mono text-[13px] md:text-[13px]"
      />
      <p id={`${field}-hint`} className="m-0 text-[13px] leading-4.5 text-muted-foreground">
        It must start with https://
      </p>
      {error ? <Callout tone="error">{error}</Callout> : null}
    </form>
  );

  return (
    <WizardCard>
      <WizardHeading title={guide.name === "your system" ? "Get your webhook address" : `Get your webhook address from ${guide.name}`} />
      <Rail tone="neutral" className="gap-1">
        <p className="m-0 text-[11px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase">
          What is a webhook address?
        </p>
        <p className="m-0 text-sm text-muted-foreground">
          A web link that belongs to your {guide.owner}. Eccos sends every new WhatsApp
          message to that link, the moment it arrives.
        </p>
      </Rail>
      <Stepper
        steps={[
          ...guide.steps.map((step, i) => ({ key: String(i), text: step.text, note: step.note })),
          { key: "paste", text: <label htmlFor={field}>Paste the address here.</label>, extra: paste },
        ]}
      />
      <WizardFooter>
        <BackAction onClick={onBack} />
        <PrimaryAction onClick={() => void save()} disabled={!valid || busy}>
          Save and test
        </PrimaryAction>
      </WizardFooter>
    </WizardCard>
  );
}
