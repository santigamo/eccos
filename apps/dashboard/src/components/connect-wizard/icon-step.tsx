import { useState } from "react";
import { cn } from "@/lib/utils";
import { Stepper } from "./stepper";
import { BackAction, PrimaryAction, Rail, TextAction, WizardCard, WizardFooter, WizardHeading } from "./wizard-frame";

type App = "regular" | "business";

/** WhatsApp's bubble, holding a phone or a B: the two icons a customer can tell apart. */
function AppIcon({ app }: { app: App }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-7 fill-none stroke-current" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      {app === "regular" ? (
        <path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-.8.8c-.9-.4-1.6-1.1-2-2l.8-.8-1-2Z" />
      ) : (
        <path d="M10 8h2.75a2 2 0 0 1 0 4H10Zm0 4h3.25a2 2 0 0 1 0 4H10Z" />
      )}
    </svg>
  );
}

const APPS: { app: App; title: string; name: string }[] = [
  { app: "regular", title: "A phone inside a bubble", name: "The app is called WhatsApp." },
  { app: "business", title: "A letter B inside a bubble", name: "The app is called WhatsApp Business." },
];

const MOVE_TO_BUSINESS = [
  { key: "install", text: "Install WhatsApp Business from your phone's app store." },
  { key: "sign-in", text: "Open it and sign in with the same number.", note: "It offers to bring your chats." },
  {
    key: "use",
    text: "Use it as usual.",
    note: "Meta often asks for about a week of normal use before it lets you connect.",
  },
];

/**
 * 1.2b: the clarifying question. Catches the regular WhatsApp case before
 * Meta's window opens, where it would only fail (3441069).
 */
export function IconStep({
  onBusinessApp,
  onOtherNumber,
  onBack,
}: {
  onBusinessApp: () => void;
  onOtherNumber: () => void;
  onBack: () => void;
}) {
  const [app, setApp] = useState<App | null>(null);
  return (
    <WizardCard>
      <WizardHeading title="Which WhatsApp icon is on your phone?">
        Look at the app you open to answer your customers.
      </WizardHeading>
      <div role="radiogroup" aria-label="Which WhatsApp icon is on your phone?" className="flex flex-col gap-2 sm:flex-row">
        {APPS.map((option) => {
          const checked = app === option.app;
          return (
            <label
              key={option.app}
              className={cn(
                "flex flex-1 cursor-pointer flex-col gap-4 border bg-(--ghost-fill) p-5 transition-colors hover:bg-(--ghost-fill-hover) has-focus-visible:ring-1 has-focus-visible:ring-ring/50",
                checked ? "border-foreground" : "border-(--line-strong) hover:border-(--ghost-edge-hover)",
              )}
            >
              <input
                type="radio"
                name="whatsapp-icon"
                value={option.app}
                checked={checked}
                onChange={() => setApp(option.app)}
                className="sr-only"
              />
              <span className="flex items-center justify-between">
                <span aria-hidden="true" className="flex size-12 items-center justify-center border border-(--line-strong) text-ink">
                  <AppIcon app={option.app} />
                </span>
                <span aria-hidden="true" className={cn("flex size-4 items-center justify-center border", checked ? "border-foreground" : "border-(--line-strong)")}>
                  {checked ? <span className="size-2 bg-foreground" /> : null}
                </span>
              </span>
              <span className="flex flex-col gap-1">
                <span className="text-[15px] leading-5 font-semibold text-foreground">{option.title}</span>
                <span className="text-sm text-muted-foreground">{option.name}</span>
              </span>
            </label>
          );
        })}
      </div>
      {app === "regular" ? (
        <Rail tone="warning" className="gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="m-0 text-[15px] leading-5 font-semibold text-foreground">Then move the number to WhatsApp Business first</p>
            <p className="m-0 text-sm text-muted-foreground">
              Meta only links the Business app. Moving takes about ten minutes and your chats come with you.
            </p>
          </div>
          <Stepper steps={MOVE_TO_BUSINESS} className="pt-0.5" />
        </Rail>
      ) : null}
      <WizardFooter>
        <div className="flex flex-wrap items-center gap-5">
          <BackAction onClick={onBack} />
          {app === "regular" ? <TextAction onClick={onOtherNumber}>Use a different number</TextAction> : null}
        </div>
        {app ? (
          <PrimaryAction onClick={onBusinessApp} icon={app === "regular" ? null : undefined}>
            {app === "regular" ? "I moved it, continue" : "Continue"}
          </PrimaryAction>
        ) : null}
      </WizardFooter>
    </WizardCard>
  );
}
