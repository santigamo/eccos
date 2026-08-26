import type { ReactNode } from "react"
import {
  ActivityIcon,
  InboxIcon,
  SendIcon,
  FileTextIcon,
  SettingsIcon,
  CheckCheckIcon,
  BellIcon,
} from "lucide-react"

export type NavItem = {
  id: string
  label: string
  href: string
  icon: ReactNode
  badge?: string | number
  isActive?: boolean
}

export const NAV_MAIN: NavItem[] = [
  {
    id: "status",
    label: "Status",
    href: "/",
    icon: <ActivityIcon aria-hidden="true" />,
  },
  {
    id: "deliveries",
    label: "Deliveries",
    href: "/deliveries",
    icon: <CheckCheckIcon aria-hidden="true" />,
  },
  {
    id: "inbound",
    label: "Inbound",
    href: "/inbound",
    icon: <InboxIcon aria-hidden="true" />,
  },
  {
    id: "outbound",
    label: "Outbound",
    href: "/outbound",
    icon: <SendIcon aria-hidden="true" />,
  },
  {
    id: "templates",
    label: "Templates",
    href: "/templates",
    icon: <FileTextIcon aria-hidden="true" />,
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    icon: <SettingsIcon aria-hidden="true" />,
  },
]
