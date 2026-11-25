import { ArrowRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionLabel } from "./wizard-frame";
import { Stepper } from "./stepper";

function currentHost(): string {
  return typeof window === "undefined" ? "this site" : window.location.host;
}

/** The browser's blocked-pop-up icon: a window with a cross. */
function BlockedIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5 fill-none stroke-foreground" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="14" height="12" />
      <path d="m15 15 6 6m0-6-6 6" />
    </svg>
  );
}

/** Where the icon is, drawn as the address bar, then the three clicks that allow Meta's window. */
export function PopupFix({ className, last = "Click the green button below." }: { className?: string; last?: string }) {
  const host = currentHost();
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <div aria-hidden="true" className="flex h-11 items-center gap-2.5 border border-(--line-strong) bg-background px-3">
        <span className="size-2.5 shrink-0 border border-(--line-strong)" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{host}</span>
        <span className="hidden text-xs text-warning-foreground sm:inline">Click this icon</span>
        <ArrowRightIcon className="hidden size-3.5 text-warning-foreground sm:block" />
        <span className="flex size-6.5 shrink-0 items-center justify-center border border-warning">
          <BlockedIcon />
        </span>
      </div>
      <div>
        <SectionLabel>What to do</SectionLabel>
        <Stepper
          steps={[
            {
              key: "icon",
              text: "Click the small icon of a window with a cross.",
              note: "It is at the top of this window, at the right end of the bar with the web address.",
            },
            { key: "allow", text: `Choose "Always allow pop-ups from ${host}", then Done.` },
            { key: "again", text: last },
          ]}
        />
      </div>
    </div>
  );
}

/** For a browser that shows no such icon. */
export const NO_ICON_NOTE =
  "Open the lock icon at the left of the address bar, then Site settings, and set Pop-ups and redirects to Allow. Then click the green button.";
