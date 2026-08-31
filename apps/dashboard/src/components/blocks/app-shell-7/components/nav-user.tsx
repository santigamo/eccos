"use client"

import { useState } from "react"
import { useLoaderData } from "@tanstack/react-router"
import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react"

import { authClient } from "@/auth/auth-client"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

/**
 * The account section of the sidebar: who is signed in, and the way out.
 *
 * The console had no sign-out affordance at all before this — a session could
 * only be ended by clearing cookies. The identity is display data resolved by
 * the root loader on the server; it is never authorization evidence.
 */
export function NavUser() {
  const root = useLoaderData({ from: "__root__" })
  const user = root.user
  const [signingOut, setSigningOut] = useState(false)

  if (!user) return null

  async function signOut() {
    setSigningOut(true)
    try {
      await authClient.signOut()
    } finally {
      // Full navigation, not a router push: the session cookie is gone, so the
      // whole loader tree has to re-run against an anonymous request.
      window.location.assign("/signin")
    }
  }

  const label = user.name?.trim() || user.email

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={user.email}
                className="data-[state=open]:bg-(--ghost-fill-hover)"
              >
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center border border-(--line-strong) text-[11px] font-medium text-muted-foreground"
                >
                  {label.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-col text-left">
                  <span className="truncate text-sm text-foreground">{label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </span>
                <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            }
          />
          {/* No identity header inside the menu: it opens directly above the
              trigger, which already shows the same name and email. */}
          <DropdownMenuContent align="end" side="top" className="min-w-56">
            <DropdownMenuItem disabled={signingOut} onClick={() => void signOut()}>
              <LogOutIcon aria-hidden="true" />
              {signingOut ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
