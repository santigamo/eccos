import { SidebarTrigger } from "@/components/ui/sidebar"

import { Logo } from "./logo"
import { MastheadBreadcrumb } from "./masthead-breadcrumb"

/**
 * The masthead. Construction is the landing's — the `--nav-bg` wash under a
 * 14px backdrop blur and a 1px bottom rule — carrying the mark, the scope
 * breadcrumb (`masthead-breadcrumb.tsx`), and the one pixel-face accent this
 * bar is allowed.
 */
export function AppHeader() {
  return (
    <header className="sticky top-0 z-50 flex w-full items-center border-b bg-(--nav-bg) backdrop-blur-[14px]">
      <div className="flex h-(--header-height) w-full items-center gap-2 px-4">
        <SidebarTrigger className="md:hidden" />

        <div className="flex shrink-0 items-center gap-2 pl-0.5">
          <Logo />
          <span className="font-heading text-foreground text-sm font-semibold tracking-widest uppercase">
            Eccos
          </span>
        </div>

        {/* The boundary between identity and scope, and it is load-bearing.
            Without it the run clusters into one typographic unit and the
            workspace name reads as part of the brand lockup — "ECCOS Meta-demo"
            parses as brand plus product line, not as a control naming a scope.
            Three things caused that and this hairline answers all three: the
            mark→wordmark gap is 8px while wordmark→crumb was only 14px (1.75×,
            under the ~2× a group split needs), the crumb rests at the same
            100% ink the wordmark uses, and semibold-uppercase followed by
            regular-mixed-case AT THE SAME SIZE is the grammar of name +
            descriptor. Interposing a divider converts that contrast from
            lockup-internal to across-a-boundary, and the existing `gap-2` on
            both sides then does the arithmetic for free: 8 + 1 + 8 + 6 = 23px,
            one logomark module and ~3× the intra-lockup gap.

            `h-4` is measured against the cap zone of the adjacent 14px type: it
            must read as a text-level divider, subordinate to the 24px mark and
            the 28px crumb, never as a full-height wall. */}
        <span
          aria-hidden="true"
          className="h-4 w-px shrink-0 bg-border"
        />

        <MastheadBreadcrumb />

        {/* Geist Pixel, here and nowhere else in the bar: a brand accent read
            once, not a control read all day (docs/DASHBOARD-DESIGN.md). */}
        <span className="text-muted-foreground font-pixel ml-auto shrink-0 text-xs tracking-[0.04em] uppercase">
          Operator Console
        </span>
      </div>
    </header>
  )
}
