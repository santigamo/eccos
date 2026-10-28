"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "@tanstack/react-router"

export const LIVE_INTERVAL_MS = 5000

type VisibilitySource = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">

/**
 * Calls `tick` every `ms` while `doc` is visible. A hidden tab polls nothing;
 * coming back ticks at once, so the operator never reads a stale page. Returns
 * the cleanup.
 */
export function pollWhileVisible(tick: () => void, ms: number, doc: VisibilitySource): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    clearInterval(timer)
    timer = undefined
  }
  const sync = () => {
    stop()
    if (doc.visibilityState !== "visible") return
    timer = setInterval(tick, ms)
  }
  const onVisibility = () => {
    if (doc.visibilityState === "visible") tick()
    sync()
  }
  sync()
  doc.addEventListener("visibilitychange", onVisibility)
  return () => {
    stop()
    doc.removeEventListener("visibilitychange", onVisibility)
  }
}

export interface LiveRefresh {
  live: boolean
  setLive: (live: boolean) => void
  refreshing: boolean
  refresh: () => void
}

/**
 * Refresh and live mode for a log page. Both re-run the current matches'
 * loaders through `router.invalidate()`, so filters and the selected number
 * (search params) stay as they are and the rows keep their ids. The live
 * choice is remembered per page in localStorage, read after mount so the
 * server render and hydration agree on "off".
 */
export function useLiveRefresh(page: string): LiveRefresh {
  const router = useRouter()
  const key = `eccos.live.${page}`
  const [live, setLiveState] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    try {
      setLiveState(localStorage.getItem(key) === "1")
    } catch {}
  }, [key])

  const setLive = useCallback(
    (next: boolean) => {
      setLiveState(next)
      try {
        localStorage.setItem(key, next ? "1" : "0")
      } catch {}
    },
    [key],
  )

  const refresh = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    void router.invalidate().finally(() => {
      inFlight.current = false
      setRefreshing(false)
    })
  }, [router])

  useEffect(() => {
    if (!live) return
    return pollWhileVisible(refresh, LIVE_INTERVAL_MS, document)
  }, [live, refresh])

  return { live, setLive, refreshing, refresh }
}
