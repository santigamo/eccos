"use client"

import { Link, useLoaderData } from "@tanstack/react-router"
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react"

import type { Membership } from "@/server/gateway"
import { useWorkspaceSwitch } from "@/hooks/use-workspace-switch"
import {
  activeWorkspace,
  hasWorkspaceChoice,
  workspaceInitial,
  workspaceLabel,
} from "@/lib/workspaces"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

/**
 * The workspace section of the sidebar: which workspace this session is scoped
 * to, the others it could be scoped to, and the way to a new one.
 *
 * The console had NO workspace control at all before this. Switching existed
 * only as a failure state — `WorkspacePicker` renders when `requirePermission`
 * refuses with `select-organization`, so a member of two workspaces chose once,
 * on their first refused request, and was pinned there for the session. And
 * creating a second workspace was built (`createOrganization`) but unreachable:
 * `/onboarding` is its only caller and the root loader ejects anyone who
 * already has a workspace from that route. Both gaps are one missing surface,
 * so this component closes both.
 *
 * It sits ABOVE `NavUser` in the sidebar footer, as its own row rather than as
 * items inside the account menu: identity and scope are different questions,
 * and the answer to "which workspace am I in" has to be readable WITHOUT
 * opening anything — it is the first thing an App Review reviewer asks.
 *
 * None of this is authorization. The list and the active marking are display
 * data from the root loader; the switch itself is validated server-side by
 * `selectOrganization` → `verifyMembership`, and every request after it
 * re-derives the tenant from the session regardless of what the client claims.
 */
export function NavWorkspace() {
  const root = useLoaderData({ from: "__root__" })
  const user = root.user
  // No session, or a session with no membership yet (the root loader is already
  // redirecting that one to /onboarding): nothing truthful to name.
  if (!user || user.workspaces.length === 0) return null
  return (
    <WorkspaceSwitcher
      workspaces={user.workspaces}
      activeWorkspaceId={user.activeWorkspaceId}
    />
  )
}

/**
 * The control itself, prop-driven so it can be rendered — and asserted —
 * without a router.
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
  // forever, and for them the menu holds only "New workspace".
  const switchable = hasWorkspaceChoice(workspaces)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={active ? workspaceLabel(active) : "Choose a workspace"}
                aria-label={
                  active ? `Workspace: ${workspaceLabel(active)}` : "Choose a workspace"
                }
                className="data-[state=open]:bg-(--ghost-fill-hover)"
              >
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center border border-(--line-strong) text-[11px] font-medium text-muted-foreground"
                >
                  {active ? workspaceInitial(active) : "?"}
                </span>
                <span className="flex min-w-0 flex-col text-left">
                  {/* Machine voice: the functional register of the console, and
                      what tells this row apart from the identity row below it. */}
                  <span className="truncate text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                    Workspace
                  </span>
                  <span className="truncate text-sm text-foreground">
                    {active ? workspaceLabel(active) : "Not selected"}
                  </span>
                </span>
                <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent align="end" side="top" className="min-w-64">
            {switchable ? (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                    Workspaces
                  </DropdownMenuLabel>
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
            {/* A real route inside the shell, NOT /onboarding: see
                routes/workspaces.new.tsx for why the two are separate. */}
            <DropdownMenuItem render={<Link to="/workspaces/new" />}>
              <PlusIcon aria-hidden="true" />
              New workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Mounted even when empty: a live region that appears with its message
            is not reliably announced, one that fills up is. The refusal shows
            in the sidebar because the menu has closed by the time it arrives. */}
        <output
          aria-live="polite"
          aria-atomic="true"
          className={
            error
              ? "mt-2 block border-l-2 border-l-[#e03131] px-2 py-1 text-xs break-words whitespace-pre-wrap text-foreground in-data-[state=collapsed]:hidden"
              : undefined
          }
        >
          {error}
        </output>
      </SidebarMenuItem>
    </SidebarMenu>
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
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center border border-(--line-strong) text-[11px] font-medium text-muted-foreground"
      >
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
