import { useState } from "react";
import { Button } from "../ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../reui/frame";
import { startConnect } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { AUTH_ERROR_BANNER_CLASS } from "../auth/auth-page";
import { cn } from "@/lib/utils";

/** What Embedded Signup will ask for, in order. Fragments, not sentences. */
const CONNECT_STEPS = [
  "Pick or create a WhatsApp Business Account",
  "Attach the phone number Eccos will use",
  "Eccos subscribes to its webhooks",
] as const;

/**
 * Start Meta Embedded Signup. Rendered as the empty state of /numbers on first
 * run and, later, from the same page when the operator adds another number:
 * connecting a number is a recurring operation, not a first-run ritual, so it
 * has one surface rather than a wizard that only exists once.
 *
 * `startConnect` performs a full navigation to the gateway, which owns the
 * Meta callback and hands the operator back to /numbers when it is done
 * (eccos-5z9) — carrying a failure code when there is one.
 */
export function ConnectNumberPanel({ heading }: { heading: string }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const result = await startConnect();
      if (!result.ok) {
        setError(failureCopy(result).detail);
        return;
      }
      window.location.assign(result.data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Frame variant="default" spacing="lg" className="max-w-3xl">
      <FramePanel fit>
        {/* The header sits level with the body: FramePanel zeroes the nested
            header's horizontal padding so the two do not stack (see frame.tsx). */}
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">{heading}</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            Meta opens in this tab. Your number stays on the WhatsApp Business
            app.
          </FrameDescription>
        </FrameHeader>

        <ol className="m-0 flex list-none flex-col gap-2.5 p-0 pt-5">
          {CONNECT_STEPS.map((text, i) => (
            <li key={text} className="flex items-baseline gap-3">
              <span
                aria-hidden="true"
                className="text-[11px] font-medium tabular-nums tracking-wider text-muted-foreground"
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-sm text-foreground">{text}</span>
            </li>
          ))}
        </ol>

        {error ? (
          <p className={cn("mt-4", AUTH_ERROR_BANNER_CLASS)} role="alert">
            {error}
          </p>
        ) : null}

        {/* One footer rail, action pinned right; full-bleed so its rule reads as
            panel chrome rather than as another content block. */}
        <footer className="-mx-(--frame-panel-px) mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-(--frame-panel-border-color) px-(--frame-panel-px) pt-4">
          <p className="m-0 text-xs text-muted-foreground">
            Meta brings you back to this page when it is done.
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" onClick={start} disabled={starting}>
              {starting ? "Opening Embedded Signup…" : "Connect WhatsApp"}
            </Button>
          </div>
        </footer>
      </FramePanel>
    </Frame>
  );
}
