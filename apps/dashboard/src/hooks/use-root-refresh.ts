"use client"

import { useEffect, useMemo } from "react"
import { useRouter } from "@tanstack/react-router"
import { invalidateRoutes, rootRouteId } from "../lib/invalidate"
import { singleFlight } from "./use-live-refresh"

/** How long the bootstrap display (stage, identity, flags) is trusted as-is. */
export const ROOT_STALE_MS = 30_000

/** Refreshes the root when the tab comes back to the foreground after `staleMs`. */
export function watchRootFreshness(
  win: Pick<Window, "addEventListener" | "removeEventListener">,
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
  loadedAt: () => number,
  refresh: () => unknown,
  staleMs = ROOT_STALE_MS,
  now: () => number = Date.now,
): () => void {
  const check = () => {
    if (doc.visibilityState === "visible" && now() - loadedAt() > staleMs) void refresh()
  }
  win.addEventListener("focus", check)
  doc.addEventListener("visibilitychange", check)
  return () => {
    win.removeEventListener("focus", check)
    doc.removeEventListener("visibilitychange", check)
  }
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
        refresh,
      ),
    [router, refresh],
  )
}
