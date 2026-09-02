"use client"

import { useState } from "react"

import { selectOrganization } from "../organizations"

/**
 * The one client path that changes which workspace this session is scoped to.
 *
 * There is deliberately no second one: the failure-state picker
 * (`components/dashboard/failure.tsx`) and the shell's workspace control
 * (`blocks/app-shell-7/components/nav-workspace.tsx`) both go through here, so
 * the membership check on the server (`selectOrganization` →
 * `verifyMembership`) and the reload afterwards can never drift apart.
 *
 * What the reload buys: `selectOrganization` writes UX state
 * (`session.activeOrganizationId`) that every loader reads back server-side. A
 * router invalidation would re-run the loaders but leave the document's already
 * rendered tenant-scoped state around it; a full reload re-runs the whole tree
 * against the new scope, which is what "I switched workspace" has to mean.
 */
export interface WorkspaceSwitch {
  /** The workspace currently being switched to, or null when idle. */
  pendingId: string | null
  /** The refusal to show, verbatim from the server. */
  error: string | null
  /** Switch to `organizationId`. A no-op while another switch is in flight. */
  choose: (organizationId: string) => void
}

export function useWorkspaceSwitch(): WorkspaceSwitch {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function choose(organizationId: string) {
    if (pendingId !== null) return
    setPendingId(organizationId)
    setError(null)
    void (async () => {
      try {
        const result = await selectOrganization({ data: { organizationId } })
        if (!result.ok) {
          setError(result.error)
          setPendingId(null)
          return
        }
        // Full reload: the root loader re-resolves the tenant server-side.
        // Deliberately leaves `pendingId` set — the button stays busy until the
        // document goes away, instead of flashing back to idle.
        window.location.reload()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setPendingId(null)
      }
    })()
  }

  return { pendingId, error, choose }
}
