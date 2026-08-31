import type { ReactNode } from "react"
import {
  ActivityIcon,
  InboxIcon,
  SendIcon,
  FileTextIcon,
  SettingsIcon,
  CheckCheckIcon,
  BellIcon,
  PhoneIcon,
} from "lucide-react"

export type NavItem = {
  id: string
  label: string
  href: string
  icon: ReactNode
  badge?: string | number
  isActive?: boolean
  /**
   * The item resolves a WABA scope server-side, so it has nothing to show
   * until the account has a number. `/numbers` is deliberately not flagged:
   * it is where an operator goes to fix exactly that.
   */
  requiresNumber?: boolean
}

export const NAV_MAIN: NavItem[] = [
  {
    id: "status",
    label: "Status",
    href: "/",
    icon: <ActivityIcon aria-hidden="true" />,
    requiresNumber: true,
  },
  {
    id: "numbers",
    label: "Numbers",
    href: "/numbers",
    icon: <PhoneIcon aria-hidden="true" />,
  },
  {
    id: "deliveries",
    label: "Deliveries",
    href: "/deliveries",
    icon: <CheckCheckIcon aria-hidden="true" />,
    requiresNumber: true,
  },
  {
    id: "inbound",
    label: "Inbound",
    href: "/inbound",
    icon: <InboxIcon aria-hidden="true" />,
    requiresNumber: true,
  },
  {
    id: "outbound",
    label: "Outbound",
    href: "/outbound",
    icon: <SendIcon aria-hidden="true" />,
    requiresNumber: true,
  },
  {
    id: "templates",
    label: "Templates",
    href: "/templates",
    icon: <FileTextIcon aria-hidden="true" />,
    requiresNumber: true,
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    icon: <SettingsIcon aria-hidden="true" />,
    requiresNumber: true,
  },
]
