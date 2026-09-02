"use client"

import { Link, useLoaderData, useLocation, useRouter } from "@tanstack/react-router"
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react"

import type { AccountWabaResource } from "@eccos/gateway-contract"
import type { Membership } from "@/auth/tenant"
import { useWorkspaceSwitch } from "@/hooks/use-workspace-switch"
import {
  activeWorkspace,
  hasWorkspaceChoice,
  workspaceInitial,
  workspaceLabel,
} from "@/lib/workspaces"
import {
  activeWaba,
  hasWabaChoice,
  wabaInitial,
  wabaLabel,
  wabaState,
} from "@/lib/wabas"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { StatusTag } from "@/ui"

/**
 * The masthead breadcrumb: **workspace · WABA**.
 *
 * This is the pattern the reui `app-shell-7` block the shell is derived from
 * actually uses — a chain of switcher dropdowns in the header, each opening a
 * list of monogrammed rows with a sub-label, a check on the active one, and the
 * create action inside the same menu. The shell took the block's sidebar and
 * its user section and left the breadcrumb behind, so the console ended up with
 * the workspace switcher in the sidebar footer (a second identity-shaped row
 * under the account row) and the WABA rendered as a raw sixteen-digit id in a
 * `Select`. Both are answered here instead, in the one place the block puts
 * them: scope belongs in the masthead, above every page, not in the footer.
 *
 * Two console rules shape it away from the stock block:
 *
 * - the separator is `·`, not `/` — the project's own idiom, the one used in
 *   page titles and in `docs/DASHBOARD-DESIGN.md`;
 * - both switchers are Inter. Geist Pixel is brand accents only, and a
 *   high-frequency control an operator reads all day is exactly what the design
 *   doc forbids putting it on. `OPERATOR CONSOLE` keeps the pixel face; nothing
 *   else in the masthead does.
 *
 * None of this is authorization. The lists and the active markings are display
 * data from the root loader; a workspace switch is validated server-side by
 * `selectOrganization` → `verifyMembership`, and the WABA scope is re-derived
 * from the account registry on every request regardless of the search param.
 */
export function MastheadBreadcrumb() {
  const root = useLoaderData({ from: "__root__" })
  const location = useLocation()
  const router = useRouter()

  const user = root.user
  // No session, or a session with no membership yet (the root loader is already
  // redirecting that one to /onboarding): nothing truthful to name.
  if (!user || user.workspaces.length === 0) return null

  // Only the `ready` stage has a resolved WABA scope. The chrome also renders
  // for an account that has none yet (it lands on /numbers, whose empty state
  // is the connect flow) — there the breadcrumb is the workspace alone.
  const scope = root.ok && root.data.stage === "ready" ? root.data.scope : null

  /**
   * Switching WABA is a URL change, not a session write: `wabaId` is the scope
   * search param every loader reads, and `before` is a cursor into the list the
   * old scope produced, so it cannot survive the switch. Unchanged from the
   * `Select` this replaced.
   */
  function selectWaba(wabaId: string) {
    const next = new URL(location.href, "https://dashboard.invalid")
    next.searchParams.set("wabaId", wabaId)
    next.searchParams.delete("before")
    void router.navigate({ href: `${next.pathname}${next.search}${next.hash}` })
  }

  return (
    <nav
      aria-label="Breadcrumb"
      // relative + self-stretch: the workspace switch's live region hangs off
      // `top-full`, which has to mean the bottom of the bar, not the bottom of
      // a 28px crumb floating inside it.
      className="relative flex min-w-0 items-center self-stretch"
    >
      <ol className="flex min-w-0 list-none items-center gap-0.5 p-0">
        <li className="flex min-w-0 items-center">
          <WorkspaceSwitcher
            workspaces={user.workspaces}
            activeWorkspaceId={user.activeWorkspaceId}
          />
        </li>
        {scope ? (
          <>
            <CrumbSeparator />
            <li className="flex min-w-0 items-center">
              <WabaSwitcher
                wabas={scope.resources.wabas}
                selectedWabaId={scope.selectedWabaId}
                onSelect={selectWaba}
              />
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  )
}

/**
 * The crumb divider. `·`, per the design doc — `/` is the stock block's and
 * belongs to file paths, not to this project's titles.
 */
export function CrumbSeparator() {
  return (
    <li
      aria-hidden="true"
      role="presentation"
      className="shrink-0 px-1 text-sm text-muted-foreground select-none"
    >
      ·
    </li>
  )
}

/**
 * One crumb that opens something. Quiet at rest so the chain reads as a
 * breadcrumb rather than as a row of selects, but it still earns the console's
 * interaction contrast: the hover raises the ghost fill AND turns the edge
 * green — the landing signature the design doc requires of every interactive
 * edge — and the open state holds that same treatment. Focus is the green ring
 * the buttons use, unchanged.
 *
 * `data-popup-open` is base-ui's own open-state attribute on a menu trigger
 * (`pressableTriggerOpenStateMapping`); a `data-[state=open]` variant never
 * matches here.
 */
const CRUMB_TRIGGER =
  "flex h-7 min-w-0 max-w-48 items-center gap-1.5 rounded-none border border-transparent px-1.5 text-sm text-foreground outline-none transition-colors hover:bg-(--ghost-fill-hover) hover:border-(--ghost-edge-hover) focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 data-popup-open:bg-(--ghost-fill-hover) data-popup-open:border-(--ghost-edge-hover)"

/** A crumb that names something without offering a choice: same box, no button. */
const CRUMB_STATIC =
  "flex h-7 min-w-0 max-w-48 items-center gap-1.5 px-1.5 text-sm text-foreground"

/**
 * The square monogram — never a circular avatar (design law 1). Menu rows only:
 * the crumb triggers deliberately carry none, because the ECCOS wordmark sits
 * immediately to their left and a second small square beside it reads as noise
 * rather than as identity. In a dropdown row there is no wordmark to compete
 * with and the monogram earns its place as a scanning anchor.
 */
const MONOGRAM =
  "flex size-6 shrink-0 items-center justify-center border border-(--line-strong) text-[11px] font-medium text-muted-foreground"

/** Inter uppercase 11px — the console's functional register, never the pixel face. */
const MACHINE_VOICE =
  "text-[11px] font-medium tracking-wider text-muted-foreground uppercase"

/**
 * Crumb 1. Prop-driven so it can be rendered — and asserted — without a router.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
}: {
  workspaces: Membership[]
  activeWorkspaceId: string | null
}) {
  const { pendingId, error, choose } = useWorkspaceSwitch()
  const active = activeWorkspace(workspaces, activeWorkspaceId)
  // A list of one is not a choice. Most operators are in exactly one workspace
  // forever, and for them the menu holds only "New workspace" — which is still
  // a real action, so this crumb stays a button either way.
  const switchable = hasWorkspaceChoice(workspaces)
  const label = active ? workspaceLabel(active) : "Not selected"

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={CRUMB_TRIGGER}
          title={label}
          aria-label={active ? `Workspace: ${label}` : "Choose a workspace"}
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          {switchable ? (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel className={MACHINE_VOICE}>Workspaces</DropdownMenuLabel>
                {workspaces.map((workspace) => {
                  const isActive = workspace.id === active?.id
                  return (
                    <DropdownMenuItem
                      key={workspace.id}
                      disabled={pendingId !== null}
                      aria-current={isActive ? "true" : undefined}
                      // The active row is a marker, not a destination: going
                      // where you already are would reload the page for
                      // nothing, so it only closes the menu.
                      onClick={() => {
                        if (!isActive) choose(workspace.id)
                      }}
                    >
                      <WorkspaceOption workspace={workspace} active={isActive} />
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {/* Create inside the switcher, as the block does. A real route inside
              the shell, NOT /onboarding: see routes/workspaces.new.tsx. */}
          <DropdownMenuItem render={<Link to="/workspaces/new" />}>
            <PlusIcon aria-hidden="true" />
            New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Mounted even when empty: a live region that appears with its message
          is not reliably announced, one that fills up is. It hangs below the
          masthead because the menu has closed by the time the refusal arrives,
          and because a 48px bar has no room to grow. */}
      <output
        aria-live="polite"
        aria-atomic="true"
        className={
          error
            ? "absolute top-full left-0 z-50 block max-w-sm border-l-2 border-l-[#e03131] bg-popover px-2 py-1 text-xs break-words whitespace-pre-wrap text-foreground shadow-md"
            : undefined
        }
      >
        {error}
      </output>
    </>
  )
}

/**
 * One workspace as the menu lists it: the square monogram (the console's
 * identity idiom, same as the user tile), the name, its slug in the machine
 * font, and a check on the one this session is scoped to.
 *
 * Plain elements only — no menu context — so the membership list and the active
 * marking can be asserted by the dashboard's DOM-less tests, which cannot reach
 * a portaled dropdown at all.
 */
export function WorkspaceOption({
  workspace,
  active,
}: {
  workspace: Membership
  active: boolean
}) {
  return (
    <span
      className="flex w-full min-w-0 items-center gap-2"
      data-workspace={workspace.id}
      data-active={active ? "true" : undefined}
    >
      <span aria-hidden="true" className={MONOGRAM}>
        {workspaceInitial(workspace)}
      </span>
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-sm text-foreground">{workspaceLabel(workspace)}</span>
        {workspace.slug ? (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {workspace.slug}
          </span>
        ) : null}
      </span>
      {active ? (
        <>
          {/* Green marks "this is the current one" — the same signal the active
              sidebar item already uses (`[data-active] svg` → text-primary). */}
          <CheckIcon aria-hidden="true" className="ml-auto size-4 text-primary" />
          <span className="sr-only">Current workspace</span>
        </>
      ) : null}
    </span>
  )
}

/**
 * Crumb 2. Prop-driven for the same reason as crumb 1: `onSelect` is the
 * router's job and the component must render without one.
 *
 * What it replaced: a `Select` whose trigger and every item showed the raw WABA
 * id in a monospace font — sixteen digits where the block puts a readable name.
 */
export function WabaSwitcher({
  wabas,
  selectedWabaId,
  onSelect,
}: {
  wabas: AccountWabaResource[]
  selectedWabaId: string | null
  onSelect: (wabaId: string) => void
}) {
  const active = activeWaba(wabas, selectedWabaId)
  // Nothing resolved (a stale `?wabaId=` for an account this operator does not
  // own): name nothing rather than name the wrong thing.
  if (!active) return null

  const label = wabaLabel(active)
  const state = wabaState(active)
  // On the always-visible crumb, colour is spent only on state that means
  // something (data rule 1) — a healthy scope is quiet. The menu rows below
  // tag every WABA, because there comparing state is the whole point.
  const tag = state === "active" ? null : <StatusTag status={state} />

  if (!hasWabaChoice(wabas)) {
    // One WABA is the normal shape of an account. The operator still SEES which
    // one they are in; they just do not get a dropdown holding a single row.
    return (
      <span className={CRUMB_STATIC} title={label} data-waba={active.wabaId}>
        <span className="truncate">{label}</span>
        {tag}
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={CRUMB_TRIGGER}
        title={label}
        aria-label={`WhatsApp Business account: ${label}`}
      >
        <span className="truncate">{label}</span>
        {tag}
        <ChevronsUpDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel className={MACHINE_VOICE}>
            WhatsApp Business accounts
          </DropdownMenuLabel>
          {wabas.map((waba) => {
            const isActive = waba.wabaId === active.wabaId
            return (
              <DropdownMenuItem
                key={waba.wabaId}
                aria-current={isActive ? "true" : undefined}
                onClick={() => {
                  if (!isActive) onSelect(waba.wabaId)
                }}
              >
                <WabaOption waba={waba} active={isActive} />
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One WABA as the menu lists it. Same anatomy as `WorkspaceOption` — square
 * monogram, name, machine-font sub-line, check on the active one — with the
 * block's commercial-plan sub-label replaced by the console's status tag, the
 * idiom the tables already use for exactly this vocabulary.
 *
 * The name is the phone number, the sub-line is the WABA id: the id is what
 * identifies the account exactly, so it stays reachable, it just stops being
 * the only thing on offer.
 *
 * Plain elements only, so the list and the active marking survive into the
 * DOM-less tests that cannot open a portaled menu.
 */
export function WabaOption({
  waba,
  active,
}: {
  waba: AccountWabaResource
  active: boolean
}) {
  return (
    <span
      className="flex w-full min-w-0 items-center gap-2"
      data-waba={waba.wabaId}
      data-active={active ? "true" : undefined}
    >
      <span aria-hidden="true" className={MONOGRAM}>
        {wabaInitial(waba)}
      </span>
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-sm text-foreground">{wabaLabel(waba)}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{waba.wabaId}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <StatusTag status={wabaState(waba)} />
        {active ? (
          <>
            <CheckIcon aria-hidden="true" className="size-4 text-primary" />
            <span className="sr-only">Current WhatsApp Business account</span>
          </>
        ) : null}
      </span>
    </span>
  )
}
