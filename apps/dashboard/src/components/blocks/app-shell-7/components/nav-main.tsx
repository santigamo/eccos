"use client"

import { Link, useLocation } from "@tanstack/react-router"

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

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase in-data-[state=collapsed]:hidden">
        Navigation
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.25">
          {NAV_MAIN.map((item) => {
            const isActive = pathname === item.href
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  tooltip={item.label}
                  isActive={isActive}
                  render={<Link to={item.href} />}
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