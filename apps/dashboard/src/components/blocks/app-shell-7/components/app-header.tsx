import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Logo } from "./logo"

export function AppHeader() {
  return (
    <header className="bg-background sticky top-0 z-50 flex w-full items-center border-b">
      <div className="flex h-(--header-height) w-full items-center gap-2 px-4">
        <SidebarTrigger className="md:hidden" />

        <div className="flex items-center gap-2 pl-0.5">
          <Logo />
          <span className="font-heading text-foreground text-sm font-semibold tracking-widest uppercase">
            Eccos
          </span>
        </div>

        <div className="ml-auto">
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap gap-1">
              <BreadcrumbItem>
                <BreadcrumbPage className="text-muted-foreground text-xs font-pixel">
                  Operator Console
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>
    </header>
  )
}