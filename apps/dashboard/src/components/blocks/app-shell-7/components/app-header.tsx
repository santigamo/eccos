import { SidebarTrigger } from "@/components/ui/sidebar"
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

        <span className="text-muted-foreground font-pixel ml-auto text-xs tracking-[0.04em] uppercase">
          Operator Console
        </span>
      </div>
    </header>
  )
}
