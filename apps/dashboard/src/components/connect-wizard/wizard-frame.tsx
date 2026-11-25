import type { ReactNode } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const WIZARD_STEPS = ["Get ready", "Your number", "What Meta shows", "Connect", "Set up", "Test"] as const;

/** "Step n of 6 · name", over six segments. The segments repeat the label, so they are hidden from readers. */
export function WizardProgress({ step, label = WIZARD_STEPS[step - 1] }: { step: number; label?: string }) {
  return (
    <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
      <p className="m-0 text-[11px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase">
        <span className="text-foreground">
          Step {step} of {WIZARD_STEPS.length}
        </span>{" "}
        · {label}
      </p>
      <div aria-hidden="true" className="flex items-center gap-1">
        {WIZARD_STEPS.map((name, i) => (
          <span key={name} className={cn("h-0.5 flex-1 sm:w-8 sm:flex-none", i < step ? "bg-foreground" : "bg-(--line)")} />
        ))}
      </div>
    </div>
  );
}

/** The bordered card one step lives in. On a phone the page is the card. */
export function WizardCard({ children }: { children: ReactNode }) {
  return (
    <section tabIndex={-1} className="flex flex-col gap-6 outline-none sm:border sm:border-border sm:bg-card sm:p-7">{children}</section>
  );
}

/** The step's question. Focus lands here when a step opens. */
export function WizardHeading({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 tabIndex={-1} className="m-0 text-lg leading-6 font-semibold tracking-[-0.01em] text-foreground outline-none">
        {title}
      </h2>
      {children ? <p className="m-0 text-sm text-pretty text-muted-foreground">{children}</p> : null}
    </div>
  );
}

/** The 11px machine-voice label over a list. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 pb-3 text-[11px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase">
      {children}
    </p>
  );
}

/** The card's last row: a way back or aside on the left, the step's one action on the right. */
export function WizardFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
      {children}
    </div>
  );
}

export function PrimaryAction({
  children,
  onClick,
  disabled,
  icon = <ArrowRightIcon aria-hidden="true" className="size-4" />,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode | null;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-12 w-full gap-2 px-5 text-[15px] leading-5 font-semibold sm:h-11 sm:w-auto"
    >
      {children}
      {icon}
    </Button>
  );
}

export function BackAction({ onClick, children = "Back" }: { onClick: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      {children}
    </button>
  );
}

export const TEXT_LINK = "text-sm font-medium text-foreground underline decoration-1 underline-offset-3 hover:decoration-2";

export function TextAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn(TEXT_LINK, "self-start")}>
      {children}
    </button>
  );
}

/** A heads-up or a problem on a 2px rail: amber warns, the strong line informs. */
export function Rail({ tone, className, children }: { tone: "warning" | "neutral"; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-l-2 py-0.5 pl-5",
        tone === "warning" ? "border-l-warning" : "border-l-(--line-strong)",
        className,
      )}
    >
      {children}
    </div>
  );
}

const MONOGRAM = "flex shrink-0 items-center justify-center border border-(--line-strong) font-semibold text-foreground";

/** The founder's way in, on every screen. `large` is the "still stuck" variant under a problem. */
export function FounderNote({ onWrite, large = false }: { onWrite: () => void; large?: boolean }) {
  const link = (
    <button type="button" onClick={onWrite} className="font-medium text-foreground underline decoration-1 underline-offset-3">
      Write to Santi
    </button>
  );
  if (!large) {
    return (
      <div className="flex items-center gap-2.5 pt-1">
        <span aria-hidden="true" className={cn(MONOGRAM, "size-6 text-xs")}>
          S
        </span>
        <p className="m-0 text-[13px] leading-4.5 text-muted-foreground">
          Stuck at any point? {link}, who built Eccos. He answers himself.
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 pt-4">
      <span aria-hidden="true" className={cn(MONOGRAM, "size-8 text-[13px]")}>
        S
      </span>
      <div className="flex flex-col gap-0.5">
        <p className="m-0 text-sm font-semibold text-foreground">Still stuck? Write to me.</p>
        <p className="m-0 text-[13px] leading-4.5 text-muted-foreground">
          I'm Santi and I built Eccos. Tell me what happened and I will sort it out with you. {link}
        </p>
      </div>
    </div>
  );
}
