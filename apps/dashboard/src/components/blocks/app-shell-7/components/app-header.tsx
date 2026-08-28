import { useLoaderData, useLocation, useRouter } from "@tanstack/react-router"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Logo } from "./logo"

export function AppHeader() {
  return (
    <header className="sticky top-0 z-50 flex w-full items-center border-b bg-(--nav-bg) backdrop-blur-[14px]">
      <div className="flex h-(--header-height) w-full items-center gap-2 px-4">
        <SidebarTrigger className="md:hidden" />

        <div className="flex items-center gap-2 pl-0.5">
          <Logo />
          <span className="font-heading text-foreground text-sm font-semibold tracking-widest uppercase">
            Eccos
          </span>
        </div>

        <WabaPicker />

        <span className="text-muted-foreground font-pixel ml-auto text-xs tracking-[0.04em] uppercase">
          Operator Console
        </span>
      </div>
    </header>
  )
}

function WabaPicker() {
  const scope = useLoaderData({ from: "__root__" })
  const location = useLocation()
  const router = useRouter()

  if (!scope.ok) return null
  const accountScope = scope.data

  function onValueChange(value: string | null) {
    if (!value || value === accountScope.selectedWabaId) return
    const next = new URL(location.href, "https://dashboard.invalid")
    next.searchParams.set("wabaId", value)
    next.searchParams.delete("before")
    void router.navigate({ href: `${next.pathname}${next.search}${next.hash}` })
  }

  return (
    <div className="ml-2 flex min-w-0 items-center">
      <label className="sr-only" htmlFor="active-waba">
        Active WABA
      </label>
      <Select value={accountScope.selectedWabaId} onValueChange={onValueChange}>
        <SelectTrigger id="active-waba" size="sm" className="max-w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" className="min-w-(--anchor-width)">
          {accountScope.resources.wabas.map((waba) => (
            <SelectItem key={waba.wabaId} value={waba.wabaId}>
              <span className="font-mono">{waba.wabaId}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
