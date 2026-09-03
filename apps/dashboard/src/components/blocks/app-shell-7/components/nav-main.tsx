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
import { hasNumberScope, hasWabaScope } from "@/lib/scope-requirements"

export function NavMain() {
  const { pathname } = useLocation()
  const { wabaId } = useSearch({ from: "__root__" })
  const root = useLoaderData({ from: "__root__" })
  // A route that cannot resolve its scope server-side is not a destination yet:
  // rendering it enabled would send the operator to a redirect, rendering it
  // disabled says why, and /numbers stays live as the way out. The two levels
  // come from the same module the root loader redirects from, so the sidebar
  // and the bounce can never disagree.
  const scope = root.ok ? root.data : null
  const hasNumber = scope !== null && hasNumberScope(scope)
  const hasWaba = scope !== null && hasWabaScope(scope)

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase in-data-[state=collapsed]:hidden">
        Navigation
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.25">
          {NAV_MAIN.map((item) => {
            const isActive = pathname === item.href
            const locked =
              item.requires === "number"
                ? !hasNumber
                : item.requires === "waba"
                  ? !hasWaba
                  : false
            // Two levels, two remedies: a WABA-level page is waiting on the
            // connection itself, a data-plane page on the number inside it.
            const blocker =
              item.requires === "waba" ? "connect a WhatsApp account first" : "connect a number first"
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  tooltip={locked ? `${item.label} (${blocker})` : item.label}
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
