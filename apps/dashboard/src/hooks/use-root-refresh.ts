"use client"

import { useEffect, useMemo } from "react"
import { useRouter } from "@tanstack/react-router"
import { PUBLIC_PATHS } from "../auth/redirect-target"
import { invalidateRoutes, rootRouteId } from "../lib/invalidate"
import { singleFlight } from "./use-live-refresh"

/** How long the bootstrap display (stage, identity, flags) is trusted as-is. */
export const ROOT_STALE_MS = 30_000

/**
 * Refreshes the root when the tab comes back to the foreground after `staleMs`.
 * Never on a public auth page: an anonymous visitor has nothing to refresh, and
 * the gate would answer the reads with a jump to bare /signin, wiping a
 * half-filled form, a reset-password token or a `?redirect=`.
 */
export function watchRootFreshness(
  win: Pick<Window, "addEventListener" | "removeEventListener">,
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
  loadedAt: () => number,
  pathname: () => string,
  refresh: () => unknown,
  staleMs = ROOT_STALE_MS,
  now: () => number = Date.now,
): () => void {
  const check = () => {
    if (PUBLIC_PATHS.has(pathname())) return
    if (doc.visibilityState === "visible" && now() - loadedAt() > staleMs) void refresh()
  }
  win.addEventListener("focus", check)
  doc.addEventListener("visibilitychange", check)
  return () => {
    win.removeEventListener("focus", check)
    doc.removeEventListener("visibilitychange", check)
  }
}

/** Status reads its counts from the root: entering it refreshes them in the background when older than `staleMs`. */
export function useFreshRootOnMount(staleMs = 5_000): void {
  const router = useRouter()
  useEffect(() => {
    const root = router.state.matches.find((m) => m.routeId === rootRouteId)
    if (root && Date.now() - root.updatedAt > staleMs) void invalidateRoutes(router, rootRouteId)
  }, [router, staleMs])
}

export function useRootRefresh(): void {
  const router = useRouter()
  const refresh = useMemo(() => singleFlight(() => invalidateRoutes(router, rootRouteId), () => {}), [router])
  useEffect(
    () =>
      watchRootFreshness(
        window,
        document,
        () => router.state.matches.find((m) => m.routeId === rootRouteId)?.updatedAt ?? Date.now(),
        () => router.state.location.pathname,
        refresh,
      ),
    [router, refresh],
  )
}
