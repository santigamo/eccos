import type { ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";
import type { ConnectPath } from "../../lib/embedded-signup";
import { MetaScreens } from "./meta-screens";
import { BackAction, PrimaryAction, Rail, WizardCard, WizardFooter, WizardHeading } from "./wizard-frame";

/** 1.3 and 1.3b: what Meta's window will ask, for the chosen path. "Open Meta" lives here. */
export function BriefStep({
  path,
  onOpen,
  onBack,
  disabled,
  awaiting,
  notice,
}: {
  path: ConnectPath;
  onOpen: () => void;
  onBack: () => void;
  /** Something stands before Meta may open: the role, a closed workspace. */
  disabled: boolean;
  /** Meta's script finished loading after the first click: the next click opens it. */
  awaiting: boolean;
  /** What stands before Meta, said above the action. */
  notice?: ReactNode;
}) {
  return (
    <WizardCard>
      <WizardHeading title="This is what Meta will ask you">
        Meta opens in its own small window. It shows four screens, in this order. Read them once, so nothing surprises you.
      </WizardHeading>
      <MetaScreens path={path} />
      {path === "new-number" ? (
        <Rail tone="warning" className="gap-1">
          <p className="m-0 text-sm text-foreground">
            <strong className="font-semibold">Is this number on WhatsApp today?</strong> It will stop working in the app when
            you finish. If you want to keep the app, go back and pick the other option.
          </p>
        </Rail>
      ) : null}
      {notice}
      <WizardFooter>
        <BackAction onClick={onBack} />
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
          <p className="m-0 text-center text-[13px] leading-4.5 text-muted-foreground sm:text-left">
            {awaiting ? "Ready. Meta opens in its own window." : "Keep this page open."}
          </p>
          <PrimaryAction onClick={onOpen} disabled={disabled} icon={<ExternalLinkIcon aria-hidden="true" className="size-4" />}>
            Open Meta
          </PrimaryAction>
        </div>
      </WizardFooter>
    </WizardCard>
  );
}
