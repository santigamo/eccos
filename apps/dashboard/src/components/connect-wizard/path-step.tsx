import { ArrowRightIcon, CloudIcon, SmartphoneIcon } from "lucide-react";
import type { ConnectPath } from "../../lib/embedded-signup";
import { BackAction, TEXT_LINK, WizardCard, WizardFooter, WizardHeading } from "./wizard-frame";

/**
 * The fork exists to prevent one mistake: the new-number path TAKES a number
 * that is live on the WhatsApp Business app OFF the app, and nothing Meta shows
 * says so. Hence the amber line on that card.
 */
const PATHS: { path: ConnectPath; icon: typeof CloudIcon; title: string; detail: string; warn?: string }[] = [
  {
    path: "business-app",
    icon: SmartphoneIcon,
    title: "In the WhatsApp Business app on my phone",
    detail: "You keep using the app exactly as today. Eccos works next to it.",
  },
  {
    path: "new-number",
    icon: CloudIcon,
    title: "It is a new number, or it is not on WhatsApp",
    detail: "Meta checks it with a code by SMS or call.",
    warn: "A number on WhatsApp today stops working in the app.",
  },
];

/** Interactive anatomy: `--ghost-fill` under a `--line-strong` edge that turns on hover. */
const CHOICE_CARD =
  "group flex w-full items-start gap-4 border border-(--line-strong) bg-(--ghost-fill) p-5 text-left transition-colors hover:border-(--ghost-edge-hover) hover:bg-(--ghost-fill-hover) focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none";

/** 1.2: where the number lives today. Fixed once Meta's window opens. */
export function PathStep({
  onPick,
  onBack,
  onCheck,
}: {
  onPick: (path: ConnectPath) => void;
  onBack: () => void;
  onCheck: () => void;
}) {
  return (
    <WizardCard>
      <WizardHeading title="Where do you use this number today?">
        Pick the one that fits. You cannot change it once Meta's window opens.
      </WizardHeading>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {PATHS.map(({ path, icon: Icon, title, detail, warn }) => (
          <li key={path}>
            <button type="button" onClick={() => onPick(path)} className={CHOICE_CARD}>
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center border border-(--line-strong) text-ink transition-colors group-hover:border-(--ghost-edge-hover)"
              >
                <Icon className="size-4.5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[15px] leading-5 font-semibold text-foreground">{title}</span>
                <span className="text-sm text-pretty text-muted-foreground">{detail}</span>
                {warn ? <span className="text-sm font-medium text-pretty text-warning-foreground">{warn}</span> : null}
              </span>
              <span aria-hidden="true" className="flex h-10 w-5 shrink-0 items-center justify-center text-foreground">
                <ArrowRightIcon className="size-4.5" />
              </span>
            </button>
          </li>
        ))}
      </ul>
      <WizardFooter>
        <BackAction onClick={onBack} />
        <p className="m-0 text-sm text-muted-foreground">
          Not sure which app you have?{" "}
          <button type="button" onClick={onCheck} className={TEXT_LINK}>
            Help me check
          </button>
        </p>
      </WizardFooter>
    </WizardCard>
  );
}
