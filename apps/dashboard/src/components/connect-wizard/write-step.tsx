import { useId, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { helpMailto } from "../../lib/connect-trouble";
import { cn } from "@/lib/utils";
import { BackAction, Rail, WizardCard, WizardFooter } from "./wizard-frame";

/**
 * 1.5f: the escape to the founder. The customer's words, with the technical
 * part the wizard already knows, handed to their own email app.
 */
export function WriteStep({ context, onBack }: { context: string[]; onBack: () => void }) {
  const [message, setMessage] = useState("");
  const field = useId();
  return (
    <WizardCard>
      <div className="flex items-start gap-4">
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center border border-(--line-strong) text-[15px] font-semibold text-foreground">
          S
        </span>
        <div className="flex flex-1 flex-col gap-2">
          <h2 tabIndex={-1} className="m-0 text-lg leading-6 font-semibold tracking-[-0.01em] text-foreground outline-none">
            Write to me and we will fix it together
          </h2>
          <p className="m-0 text-sm text-muted-foreground">
            I'm Santi. I built Eccos and I read every message myself. You do not need the right words. Tell me what you saw.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={field} className="text-[11px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase">
          What happened?
        </label>
        <Textarea
          id={field}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="min-h-28 bg-(--ghost-fill) px-3.5 py-3 text-sm md:text-sm"
        />
      </div>
      <Rail tone="neutral" className="gap-2.5">
        <p className="m-0 text-sm text-foreground">
          <strong className="font-semibold">We add the technical part for you.</strong>{" "}
          <span className="text-muted-foreground">Santi will see this next to your message:</span>
        </p>
        <p className="m-0 font-mono text-xs leading-4.5 whitespace-pre-wrap text-muted-foreground">{context.join("\n")}</p>
      </Rail>
      <WizardFooter>
        <BackAction onClick={onBack} />
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
          <p className="m-0 text-center text-[13px] leading-4.5 text-muted-foreground sm:text-left">Your email app opens with it ready.</p>
          <a
            href={helpMailto(message, context)}
            className={cn(buttonVariants(), "h-12 w-full px-5 text-[15px] leading-5 font-semibold sm:h-11 sm:w-auto")}
          >
            Send to Santi
          </a>
        </div>
      </WizardFooter>
    </WizardCard>
  );
}
