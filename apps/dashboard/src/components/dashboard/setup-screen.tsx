import { useState } from "react";
import { Button } from "../ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../reui/frame";
import { Logo } from "../blocks/app-shell-7/components/logo";
import { Page } from "../../ui";
import { startConnect, type DashboardState } from "../../server/gateway";
import { AUTH_ERROR_BANNER_CLASS } from "../auth/auth-page";
import { cn } from "@/lib/utils";

/**
 * First run: attach a WhatsApp Business Account.
 *
 * The route renders outside the AppShell (there is nothing to navigate to
 * yet), so it rebuilds the console's two fixed pieces rather than inventing a
 * third: the masthead is the same band as `app-header.tsx` (logomark, Inter
 * wordmark, pixel label right), and the body is the shared `Page` anatomy
 * (pixel kicker, light Inter heading, hatch band). The only difference from a
 * normal route is the missing sidebar and a reading measure on the column.
 *
 * One screen, not a wizard. Embedded Signup is the only way in, and the done
 * state lives on the other side of a full navigation to Meta (eccos-5z9), so a
 * step rail would advertise steps nobody walks.
 */
export function SetupScreen({ state }: { state: DashboardState }) {
  const account = state.stage === "account-ready" ? state.resources.account : null;

  return (
    <div className="flex min-h-svh flex-col">
      <SetupHeader workspace={account?.name?.trim() || ""} />
      <main id="main-content" className="flex flex-1 flex-col p-4 md:p-6">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
          <Page title="Connect WhatsApp" kicker="First run">
            <ConnectPanel />
          </Page>
        </div>
      </main>
    </div>
  );
}

/**
 * The console masthead, minus the WABA picker (there is no WABA yet). The
 * workspace name takes the picker's slot: that position holds the current
 * scope on every other page.
 */
function SetupHeader({ workspace }: { workspace: string }) {
  return (
    <header className="sticky top-0 z-50 flex w-full items-center border-b bg-(--nav-bg) backdrop-blur-[14px]">
      <div className="flex h-12 w-full items-center gap-2 px-4">
        <div className="flex items-center gap-2 pl-0.5">
          <Logo />
          <span className="font-heading text-foreground text-sm font-semibold tracking-widest uppercase">
            Eccos
          </span>
        </div>
        {workspace ? (
          <span className="ml-2 min-w-0 truncate text-sm text-muted-foreground">
            {workspace}
          </span>
        ) : null}
        <span className="text-muted-foreground font-pixel ml-auto text-xs tracking-[0.04em] uppercase">
          Operator Console
        </span>
      </div>
    </header>
  );
}

/** What Embedded Signup will ask for, in order. Fragments, not sentences. */
const CONNECT_STEPS = [
  "Pick or create a WhatsApp Business Account",
  "Attach the phone number Eccos will use",
  "Eccos subscribes to its webhooks",
] as const;

function ConnectPanel() {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const result = await startConnect();
      if (!result.ok) {
        setError(result.error);
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
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        {/* The header sits level with the body: FramePanel zeroes the nested
            header's horizontal padding so the two do not stack (see frame.tsx). */}
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">
            Meta Embedded Signup
          </FrameTitle>
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
          {/* Kept deliberately: Meta drops the operator on the gateway's own
              result page, not back here (eccos-5z9). Without this line the
              flow dead-ends. */}
          <p className="m-0 text-xs text-muted-foreground">
            Come back here once Meta confirms the account.
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
