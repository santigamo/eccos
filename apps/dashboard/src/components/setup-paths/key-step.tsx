import { type FormEvent, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { friendlyFailure } from "../../lib/failure";
import { issueApiKey } from "../../server/gateway";
import { Callout } from "../ui/callout";
import { BackAction, PrimaryAction, Rail, WizardCard, WizardFooter, WizardHeading } from "../connect-wizard/wizard-frame";

/** 2.C1: an API key, named, issued through the same server function /api-keys uses. */
export function KeyStep({ onIssued, onBack }: { onIssued: (apiKey: string) => void; onBack: () => void }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useId();

  async function create(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await issueApiKey({ data: { label: label.trim() || undefined } });
      if (res.ok) onIssued(res.data.apiKey);
      else setError(friendlyFailure(res, "We couldn't create the key. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <WizardCard>
      <WizardHeading title="Create your API key" />
      <Rail tone="neutral" className="gap-1">
        <p className="m-0 text-[11px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase">What is an API key?</p>
        <p className="m-0 text-sm text-muted-foreground">
          A password for your software. With it, your program can send WhatsApp messages through Eccos. Keep it secret, like
          a bank PIN.
        </p>
      </Rail>
      <form onSubmit={(e) => void create(e)} className="flex flex-col gap-2">
        <label htmlFor={field} className="text-[11px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase">
          Give it a name, so you recognise it later
        </label>
        <Input
          id={field}
          value={label}
          maxLength={100}
          placeholder="Booking system"
          onChange={(e) => setLabel(e.target.value)}
          className="h-11 bg-(--ghost-fill) px-3.5 text-sm md:text-sm"
        />
        <p className="m-0 text-[13px] leading-4.5 text-muted-foreground">For example, the name of the program that will use it.</p>
        {error ? <Callout tone="error">{error}</Callout> : null}
      </form>
      <WizardFooter>
        <BackAction onClick={onBack} />
        <PrimaryAction onClick={() => void create()} disabled={busy}>
          Create key
        </PrimaryAction>
      </WizardFooter>
    </WizardCard>
  );
}
