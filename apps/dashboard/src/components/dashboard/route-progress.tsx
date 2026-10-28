"use client"

import { useEffect, useRef, useState } from "react"
import { useRouterState, type RouterState } from "@tanstack/react-router"

/**
 * The rail at the top edge that says a navigation is in flight.
 *
 * WHY THIS EXISTS. Every console route with a loader crosses the RPC service
 * binding to the gateway, and TanStack keeps the PREVIOUS match mounted while
 * the next one loads. Meanwhile `useLocation()` reads `state.location`, which
 * the router points at the destination the moment a link is pressed — so the
 * sidebar's active item moves instantly and the page under it does not. With
 * nothing in between, a 400ms load reads as a dead click, and the console
 * reads as slow even when the gateway is fast.
 *
 * `isLoading` is set by the router's own load cycle and excludes preloads, so
 * this only ever lights for a navigation the operator actually asked for — see
 * `isNavigating` for why a reload of the current page does not count.
 *
 * The visual contract (the sweep, the reduced-motion fallback, why it is
 * indeterminate) lives with the `.route-progress` rule in `app.css`.
 */
export function RouteProgress() {
  const isLoading = useRouterState({ select: isNavigating })
  const [visible, setVisible] = useState(false)
  const shownAt = useRef(0)

  useEffect(() => {
    if (isLoading) {
      if (!visible) shownAt.current = Date.now()
      setVisible(true)
      return
    }
    if (!visible) return
    // A cached or near-instant navigation would otherwise flash the rail for
    // one frame, which reads as a glitch rather than as an answer. Holding it
    // for the rest of the floor turns every navigation into the same gesture.
    const remaining = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt.current))
    const timer = setTimeout(() => setVisible(false), remaining)
    return () => clearTimeout(timer)
  }, [isLoading, visible])

  return (
    <>
      <div
        className="route-progress"
        data-loading={visible || undefined}
        aria-hidden="true"
      />
      {/* The rail is decoration; this is the announcement. A route change
          swaps the whole main region with no focus move, so without a live
          region a screen reader gets no notice that anything happened.
          `<output>` rather than a div with role="status": same implicit role,
          and it is the element the platform already has for it. */}
      <output aria-live="polite" className="sr-only">
        {isLoading ? "Loading page" : ""}
      </output>
    </>
  )
}

/**
 * `router.invalidate()` (Refresh, Live, a reload after a mutation) runs the
 * same load cycle as a navigation, but the location never moves: the page
 * under it stays put and the control that asked owns the busy state. Only a
 * load headed somewhere else is a navigation.
 */
export function isNavigating(
  state: Pick<RouterState, "isLoading" | "location" | "resolvedLocation">,
): boolean {
  return state.isLoading && state.location.href !== state.resolvedLocation?.href
}

/** Once up, the rail stays up this long — see the effect above. */
const MIN_VISIBLE_MS = 320
