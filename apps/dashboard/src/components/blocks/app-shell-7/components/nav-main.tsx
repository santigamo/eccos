"use client"

import { Link, useLoaderData, useLocation, useSearch } from "@tanstack/react-router"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { NAV_MAIN } from "./data"

export function NavMain() {
  const { pathname } = useLocation()
  const { wabaId } = useSearch({ from: "__root__" })
  const root = useLoaderData({ from: "__root__" })
  // Every scoped route resolves a WABA server-side and throws without one, so
  // before the first number they are not destinations yet. Rendering them
  // enabled would send the operator to a redirect; rendering them disabled
  // says why, and /numbers stays live as the way out.
  const hasNumber = root.ok && root.data.stage === "ready"

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase in-data-[state=collapsed]:hidden">
        Navigation
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.25">
          {NAV_MAIN.map((item) => {
            const isActive = pathname === item.href
            const locked = Boolean(item.requiresNumber) && !hasNumber
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  tooltip={locked ? `${item.label} (connect a number first)` : item.label}
                  isActive={isActive}
                  aria-disabled={locked || undefined}
                  className={locked ? "pointer-events-none opacity-40" : undefined}
                  render={
                    locked ? (
                      <span />
                    ) : (
                      <Link to={item.href} search={{ wabaId }} />
                    )
                  }
                >
                  {item.icon}
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
