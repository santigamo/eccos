import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar"

import { NavMain } from "./nav-main"
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