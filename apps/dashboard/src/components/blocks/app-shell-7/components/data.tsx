import type { ReactNode } from "react"
import {
  ActivityIcon,
  InboxIcon,
  SendIcon,
  FileTextIcon,
  SettingsIcon,
  CheckCheckIcon,
  WebhookIcon,
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
   *   and its stored token, and the forwarding target is what you set up BEFORE
   *   any traffic. Both are reachable while a connected WABA still awaits its
   *   phone number.
   * - unset — always live. `/numbers` is deliberately unflagged: it is where an
   *   operator goes to fix exactly this. `/settings` is unflagged too, on the
   *   Workspace panel's own merits — the account id is an account-level fact
   *   and does not wait on a number. (It used to be unflagged BECAUSE it
   *   carried the pasted-token panel; that panel now lives on its own unlisted
   *   route, `/numbers/attach-token`, which is where that argument went.)
   *
   * The values must match `lib/scope-requirements.ts`, which the root loader
   * redirects from; `tests/scope-requirements.test.ts` fails if they drift.
   */
  requires?: "waba" | "number"
}

/**
 * One labelled section of the sidebar.
 *
 * `label` is null for the lead group: a single Status row needs no heading over
 * it, and the old blanket "Navigation" label named the whole list rather than
 * telling an operator anything.
 */
export type NavGroup = {
  id: string
  /** Machine-voice heading (Inter 11px uppercase), or null for the lead group. */
  label: string | null
  items: NavItem[]
}

/**
 * The sidebar, in three named groups plus the lead Status row.
 *
 * GROUPED, NOT COLLAPSIBLE. Nine items do not need collapsing — the reference
 * console this borrows its information architecture from collapses because it
 * carries fifteen, and there is no `Collapsible` primitive vendored here. What
 * the grouping buys is that the `requires` levels cluster visually: on a fresh
 * account the whole LOGS group dims together, reading as "later", where three
 * greyed rows scattered through one flat list read as three unrelated faults.
 *
 * `tests/scope-requirements.test.ts` flattens this and holds every item's
 * `requires` against `lib/scope-requirements.ts`.
 */
export const NAV_MAIN: NavGroup[] = [
  {
    id: "overview",
    label: null,
    items: [
      {
        id: "status",
        label: "Status",
        href: "/",
        icon: <ActivityIcon aria-hidden="true" />,
        requires: "number",
      },
    ],
  },
  {
    id: "setup",
    label: "Setup",
    items: [
      {
        id: "numbers",
        label: "Numbers",
        href: "/numbers",
        icon: <PhoneIcon aria-hidden="true" />,
      },
      {
        id: "webhooks",
        label: "Webhooks",
        href: "/webhooks",
        icon: <WebhookIcon aria-hidden="true" />,
        requires: "waba",
      },
      {
        id: "templates",
        label: "Templates",
        href: "/templates",
        icon: <FileTextIcon aria-hidden="true" />,
        requires: "waba",
      },
    ],
  },
  {
    id: "logs",
    label: "Logs",
    items: [
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
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        id: "settings",
        label: "Settings",
        href: "/settings",
        icon: <SettingsIcon aria-hidden="true" />,
      },
    ],
  },
]
