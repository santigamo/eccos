import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar"

import { NavMain } from "./nav-main"
import { NavSetup } from "./nav-setup"
import { NavUser } from "./nav-user"
import { SidebarRailToggle } from "./sidebar-rail-toggle"

export function AppSidebar() {
  const { isMobile } = useSidebar()

  return (
    <Sidebar
      collapsible="icon"
      // Pinned by its edges rather than a `100svh` height: Chrome can report
      // `svh` taller than the visible viewport, which pushed the column's end
      // off screen where no scroll reaches it. The nav list scrolls inside.
      className="top-(--header-height) bottom-0 h-auto!"
    >
      <SidebarContent className="gap-2 px-2 pt-2">
        <NavMain />
        {/* The setup companion, after the navigation and in the same scroll:
            on a short viewport it scrolls, it never covers a nav link. It
            removes itself once setup is done, or when the viewer hides it. */}
        <NavSetup />
      </SidebarContent>

      {/* Identity only. Scope — which workspace, which WABA — lives in the
          masthead breadcrumb, where the block this shell is derived from puts
          it; two identity-shaped rows stacked in this footer was the shell
          answering the same question twice. */}
      <SidebarFooter className="gap-2 px-2 pb-4">
        <NavUser />
        <p className="text-muted-foreground font-pixel px-2 text-[11px] tracking-wider uppercase in-data-[state=collapsed]:hidden">
          v0.1.0
        </p>
      </SidebarFooter>

      {!isMobile && <SidebarRailToggle />}
    </Sidebar>
  )
}
