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
