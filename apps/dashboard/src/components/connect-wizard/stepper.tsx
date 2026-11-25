import type { ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LiveState } from "@/lib/connect-live";

export type StepperStep = {
  key: string;
  /** The white instruction. */
  text: ReactNode;
  /** The muted line under it. */
  note?: ReactNode;
  /** Live lists only: done, now, or still to come. Instruction lists leave it out. */
  state?: LiveState;
  /** Right-aligned, for a done fact's time. */
  aside?: ReactNode;
  /** Under the note, such as a copy button. */
  extra?: ReactNode;
};

/** The marker is drawn, so a reader hears the state instead. */
const STATE_WORDS: Record<LiveState, string> = { done: "Done: ", now: "Now: ", next: "Next: " };

function Marker({ index, state }: { index: number; state?: LiveState }) {
  if (state === "done") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center border border-foreground bg-foreground text-background">
        <CheckIcon aria-hidden="true" strokeWidth={2.5} className="size-3" />
      </span>
    );
  }
  if (state === "now") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center border border-foreground">
        <span className="size-1.5 bg-foreground" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center border border-(--line-strong)">
      <span className={cn("text-xs leading-4 font-semibold", state === "next" ? "text-muted-foreground" : "text-foreground")}>
        {index + 1}
      </span>
    </span>
  );
}

/** The vertical stepper: a 20px square marker, a thread to the next step, the instruction and its note. */
export function Stepper({ steps, className }: { steps: StepperStep[]; className?: string }) {
  return (
    <ol className={cn("m-0 flex list-none flex-col p-0", className)}>
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={step.key} className="flex gap-3" aria-current={step.state === "now" ? "step" : undefined}>
            <div aria-hidden="true" className={cn("flex w-5 shrink-0 flex-col items-center gap-1", !last && "pb-1")}>
              <Marker index={i} state={step.state} />
              {last ? null : <span className="w-px flex-1 bg-foreground/20" />}
            </div>
            <div className={cn("flex min-w-0 flex-1 gap-3", !last && "pb-4.5")}>
              <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                <span
                  className={cn(
                    "text-sm leading-5",
                    step.state === "now"
                      ? "font-semibold text-foreground"
                      : step.state === "done" || step.state === "next"
                        ? "text-muted-foreground"
                        : "text-foreground",
                  )}
                >
                  {step.state ? <span className="sr-only">{STATE_WORDS[step.state]}</span> : null}
                  {step.text}
                </span>
                {step.note ? <span className="text-[13px] leading-4.5 text-muted-foreground">{step.note}</span> : null}
                {step.extra ? <div className="w-full pt-2">{step.extra}</div> : null}
              </div>
              {step.aside ? (
                <span className="w-12 shrink-0 text-right font-mono text-xs leading-5 text-muted-foreground">{step.aside}</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
