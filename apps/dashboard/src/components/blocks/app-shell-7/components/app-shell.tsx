import { Outlet } from "@tanstack/react-router"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import { AppHeader } from "./app-header"
import { AppSidebar } from "./app-sidebar"

export function AppShell() {
  return (
    <SidebarProvider
      className="flex h-svh flex-col"
      style={
        {
          "--sidebar-width": "240px",
          "--sidebar-width-icon": "62px",
          "--header-height": "48px",
        } as React.CSSProperties
      }
    >
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        <AppSidebar />
        {/* bg-transparent: the inset's default bg-background is opaque and the
            body already paints it — transparent lets the fixed atmosphere glow
            (body::before) reach the content column. */}
        <SidebarInset id="main-content" className="min-h-0 bg-transparent">
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
            <Outlet />
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  )
}