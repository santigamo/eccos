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
      className="top-(--header-height) h-[calc(100svh-var(--header-height))]!"
    >
      <SidebarContent className="gap-2 px-2 pt-2">
        <NavMain />
      </SidebarContent>

      {/* Identity only. Scope — which workspace, which WABA — lives in the
          masthead breadcrumb, where the block this shell is derived from puts
          it; two identity-shaped rows stacked in this footer was the shell
          answering the same question twice. */}
      <SidebarFooter className="gap-2 px-2 pb-4">
        {/* Above the user tile, at the bottom of the column: first run is the
            only time it exists, and it must not push the navigation down the
            page for everyone who is past it. It removes itself when the four
            steps are facts, or when the viewer hides it. */}
        <NavSetup />
        <NavUser />
        <p className="text-muted-foreground font-pixel px-2 text-[11px] tracking-wider uppercase in-data-[state=collapsed]:hidden">
          v0.1.0
        </p>
      </SidebarFooter>

      {!isMobile && <SidebarRailToggle />}
    </Sidebar>
  )
}
