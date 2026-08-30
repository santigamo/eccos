import type { ReactNode } from "react";

import { Frame, FramePanel } from "@/components/reui/frame";
import { SilkPanel } from "./silk-panel";

/**
 * Split-screen shell adapted from the reui auth-13 block to the Eccos design
 * contract: dark-only, glass brand panel instead of the stock Unsplash
 * photography (self-hosted builds must not depend on external image hosts),
 * the landing's pixel kicker + light Inter heading, and no extra atmosphere
 * layers (the ambient glow and the lantern already own the floor — "do not
 * add a second ambient motion"). The hatch band is deliberately absent: over
 * the silk it read as noise, not as the chapter divider it is on flat pages.
 *
 * The form column (children) is owned by the route; this shell owns the
 * grid and the brand panel.
 */
export function AuthSplitShell({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="min-h-svh w-full lg:h-svh lg:overflow-hidden"
    >
      <div className="grid min-h-svh w-full gap-8 px-4 py-4 sm:px-6 sm:py-6 lg:h-svh lg:min-h-0 lg:grid-cols-[32rem_minmax(0,1fr)] lg:gap-8 lg:px-0 lg:py-0">
        {/* Brand panel — desktop-only decoration (hidden below lg): below the
            breakpoint the form is the whole page and the silk only reads as
            filler competing with it. */}
        <aside className="order-2 hidden lg:order-1 lg:flex lg:min-h-full lg:items-stretch lg:justify-start lg:h-full lg:min-h-0 lg:w-full lg:self-stretch lg:justify-self-start lg:py-7 lg:pl-7">
          <div className="w-full lg:sticky lg:top-7 lg:h-[calc(100svh-3.5rem)]">
            <Frame
              spacing="lg"
              className="h-full w-full border-border/70 bg-transparent"
            >
              <FramePanel className="relative h-full min-h-[32rem] overflow-hidden p-0 shadow-none before:hidden">
                {/* The landing's iridescent silk under the glass — the
                    pre-auth surface's one spectacle (see DASHBOARD-DESIGN.md
                    "Atmosphere"). The translucent panel tints/scrim it so the
                    copy clears; the CSS gradient below is the no-WebGL/reduced
                    -motion fallback. */}
                <SilkPanel className="absolute inset-0 hidden lg:block" />
                <div
                  className="pointer-events-none absolute inset-0 hidden lg:block"
                  style={{
                    background:
                      "linear-gradient(to right, rgba(7,12,15,0.72) 0%, rgba(7,12,15,0.42) 45%, rgba(7,12,15,0.08) 100%)",
                  }}
                  aria-hidden="true"
                />
                <div className="relative flex min-h-0 flex-1 flex-col justify-between gap-10 p-8 xl:p-10">
                  <div className="flex flex-col gap-4">
                    <p className="text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
                      The official WhatsApp Cloud API
                    </p>
                    <h2 className="text-[1.75rem] leading-tight font-normal tracking-[-0.012em] text-foreground text-balance">
                      Your numbers. Your server.{" "}
                      <br />
                      Your rules.
                    </h2>
                    <p className="text-muted-foreground max-w-sm text-sm text-pretty">
                      Automate WhatsApp on Meta&apos;s official API, on
                      infrastructure you own. No middleman, no per-message
                      markup.
                    </p>
                  </div>
                </div>
              </FramePanel>
            </Frame>
          </div>
        </aside>

        {/* Form column — first in DOM order on mobile: the sign-in form is
            the page's protagonist; the brand panel is decoration. */}
        <section className="order-1 flex min-h-[calc(100svh-2rem)] items-center justify-center px-4 py-8 sm:px-8 lg:order-2 lg:h-full lg:min-h-0 lg:px-12 lg:py-0 xl:px-16 2xl:px-20">
          {children}
        </section>
      </div>
    </main>
  );
}
