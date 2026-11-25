import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { type ConnectLive, clockTime, liveRows } from "../../lib/connect-live";
import type { ConnectPath } from "../../lib/embedded-signup";
import { Button } from "@/components/ui/button";
import { Stepper } from "./stepper";
import { PopupFix } from "./popup-fix";
import { PrimaryAction, Rail, TEXT_LINK, WizardCard, WizardFooter, WizardHeading } from "./wizard-frame";

const KICKER = "m-0 flex items-center gap-2 text-[11px] leading-3.5 font-semibold tracking-wider text-foreground uppercase";

/** The four observed facts as a stepper, and the latest one announced. */
function LiveList({ live, path }: { live: ConnectLive; path: ConnectPath }) {
  const rows = liveRows(live, path);
  const latest = rows.filter((row) => row.state === "done").at(-1);
  return (
    <div className="border-t border-border pt-6">
      <Stepper
        steps={rows.map((row) => ({
          key: row.id,
          text: row.label,
          note: row.note,
          state: row.state,
          aside: row.at === undefined ? undefined : clockTime(row.at),
        }))}
      />
      <p role="status" className="sr-only">
        {latest ? `${latest.label}.` : ""}
      </p>
    </div>
  );
}

/** 1.4: Meta's window is out. Moves only on what this page observes; Meta's screens wait for the customer. */
export function LiveStep({
  live,
  path,
  slow,
  onCancel,
  onReopen,
}: {
  live: ConnectLive;
  path: ConnectPath;
  /** Nothing took focus after the window should have opened. */
  slow: boolean;
  onCancel: () => void;
  onReopen: () => void;
}) {
  const [fix, setFix] = useState(false);
  // Once Meta answered, the exchange is in flight and may not be abandoned.
  const answered = live.finishedAt !== undefined;
  return (
    <WizardCard>
      <div className="flex flex-col gap-2">
        <p className={KICKER}>
          <span aria-hidden="true" className="flex gap-0.75">
            <span className="size-1.25 bg-foreground" />
            <span className="size-1.25 bg-foreground opacity-55" />
            <span className="size-1.25 bg-foreground opacity-25" />
          </span>
          Live
        </p>
        <WizardHeading title={live.openedAt ? "Meta's window is open" : "Opening Meta's window"}>
          Finish there. This list updates by itself, you do not need to click anything here.
        </WizardHeading>
      </div>
      <LiveList live={live} path={path} />
      {slow && !answered ? (
        <Rail tone="neutral">
          <p className="m-0 text-[15px] leading-5 font-semibold text-foreground">Don't see Meta's window?</p>
          <p className="m-0 text-sm text-muted-foreground">
            It may be hiding behind this one. Look for a second browser window. If nothing opened at all, your browser
            blocked it, and that has a quick fix.
          </p>
          {fix ? (
            <PopupFix className="pt-2" last="Click Open Meta again, below." />
          ) : (
            <button type="button" onClick={() => setFix(true)} className={`${TEXT_LINK} self-start`}>
              Show me the fix
            </button>
          )}
        </Rail>
      ) : null}
      {answered ? null : (
        <WizardFooter>
          <button type="button" onClick={onCancel} className="self-start text-sm font-medium text-muted-foreground hover:text-foreground">
            Cancel and go back
          </button>
          <Button
            type="button"
            variant="outline"
            onClick={onReopen}
            className="h-12 w-full px-5 text-[15px] leading-5 font-medium sm:h-11 sm:w-auto"
          >
            Open Meta again
          </Button>
        </WizardFooter>
      )}
    </WizardCard>
  );
}

/** 1.4b: the number is registered. `onContinue` goes on to setting it up (/setup). */
export function ConnectedStep({
  live,
  path,
  onContinue,
}: {
  live: ConnectLive;
  path: ConnectPath;
  onContinue: () => void;
}) {
  const phone = live.connected?.phone;
  return (
    <WizardCard>
      <div className="flex flex-col gap-2">
        <p className={KICKER}>
          <CheckIcon aria-hidden="true" strokeWidth={2.5} className="size-3.5" />
          Connected
        </p>
        <WizardHeading title="Your number is connected">
          {phone ? <span className="font-mono text-[13px] text-foreground">{phone}</span> : "Your number"} is now on Eccos.
          {path === "business-app" ? " Nothing changed on your phone." : null}
        </WizardHeading>
      </div>
      <LiveList live={live} path={path} />
      <WizardFooter>
        <p className="m-0 text-center text-[13px] leading-4.5 text-muted-foreground sm:text-left">
          Your number stays connected if you leave this page.
        </p>
        <PrimaryAction onClick={onContinue}>Continue</PrimaryAction>
      </WizardFooter>
    </WizardCard>
  );
}
