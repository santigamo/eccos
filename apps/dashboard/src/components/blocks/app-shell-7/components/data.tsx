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
   * What the item needs from the tenant's scope before it is a destination.
   *
   * - `"number"` — it reads the per-WABA data plane, which does not exist until
   *   a WABA is active.
   * - `"waba"` — it only needs a WABA to exist: templates list from the WABA id
   *   and its stored token, and subscriber config is what you set up BEFORE any
   *   traffic. Both are reachable while a connected WABA still awaits its phone
   *   number.
   * - unset — always live. `/numbers` is deliberately unflagged: it is where an
   *   operator goes to fix exactly this, and `/settings` joined it for the same
   *   reason — its pasted-token panel attaches Meta's Cloud API test number,
   *   which an account with no number is precisely who needs (eccos-up9).
   *
   * The values must match `lib/scope-requirements.ts`, which the root loader
   * redirects from; `tests/scope-requirements.test.ts` fails if they drift.
   */
  requires?: "waba" | "number"
}

export const NAV_MAIN: NavItem[] = [
  {
    id: "status",
    label: "Status",
    href: "/",
    icon: <ActivityIcon aria-hidden="true" />,
    requires: "number",
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
    requires: "number",
  },
  {
    id: "inbound",
    label: "Inbound",
    href: "/inbound",
    icon: <InboxIcon aria-hidden="true" />,
    requires: "number",
  },
  {
    id: "outbound",
    label: "Outbound",
    href: "/outbound",
    icon: <SendIcon aria-hidden="true" />,
    requires: "number",
  },
  {
    id: "templates",
    label: "Templates",
    href: "/templates",
    icon: <FileTextIcon aria-hidden="true" />,
    requires: "waba",
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    icon: <SettingsIcon aria-hidden="true" />,
  },
]
