"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "@tanstack/react-router"
import { invalidatePage } from "../lib/invalidate"

export const LIVE_INTERVAL_MS = 5000

type VisibilitySource = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">

/**
 * Calls `tick` every `ms` while `doc` is visible. A hidden tab polls nothing;
 * coming back ticks at once, so the operator never reads a stale page. Returns
 * the cleanup.
 */
export function pollWhileVisible(tick: () => unknown, ms: number, doc: VisibilitySource): () => void {
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
  /** Resolves when the reload settles; a call while one is in flight joins it. */
  refresh: () => Promise<void>
}

type Invalidate = () => Promise<unknown>

/**
 * One reload at a time: a call while one is in flight gets the same promise,
 * so a slow gateway never stacks ticks. The promise never rejects — a failed
 * page load renders in the page, and a timer has nobody to hand an error to.
 */
export function singleFlight(invalidate: Invalidate, onBusy: (busy: boolean) => void): () => Promise<void> {
  let inFlight: Promise<void> | undefined
  return () => {
    if (inFlight) return inFlight
    onBusy(true)
    inFlight = invalidate()
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        inFlight = undefined
        onBusy(false)
      })
    return inFlight
  }
}

/**
 * Refresh and live mode for a log page. Both re-run the current matches'
 * loaders through `invalidatePage` (never the root), so filters and the selected number
 * (search params) stay as they are and the rows keep their ids. The live
 * choice is remembered per page in localStorage, read after mount so the
 * server render and hydration agree on "off".
 *
 * `auto` polls too while the operator has made no choice on this page; a
 * stored "off" wins over it.
 */
export function useLiveRefresh(page: string, auto = false): LiveRefresh {
  const router = useRouter()
  const [choice, setChoice] = useState<boolean | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useMemo(() => singleFlight(() => invalidatePage(router), setRefreshing), [router])

  useEffect(() => {
    setChoice(readLiveChoice(page))
  }, [page])

  const setLive = useCallback(
    (next: boolean) => {
      setChoice(next)
      writeLive(page, next)
    },
    [page],
  )

  const polling = choice ?? auto
  useEffect(() => {
    if (!polling) return
    return pollWhileVisible(refresh, LIVE_INTERVAL_MS, document)
  }, [polling, refresh])

  return { live: choice === true, setLive, refreshing, refresh }
}

/**
 * Always live, for a page that is an inbox: re-reads the page every
 * `LIVE_INTERVAL_MS` while the tab is visible. No button and no stored choice.
 */
export function useAlwaysLive(): void {
  const router = useRouter()
  const refresh = useMemo(() => singleFlight(() => invalidatePage(router), () => {}), [router])
  useEffect(() => pollWhileVisible(refresh, LIVE_INTERVAL_MS, document), [refresh])
}

const liveKey = (page: string) => `eccos.live.${page}`

/** The stored choice, or null when the operator never toggled this page. */
export function readLiveChoice(page: string): boolean | null {
  try {
    const stored = localStorage.getItem(liveKey(page))
    return stored === null ? null : stored === "1"
  } catch {
    return null
  }
}

export function readLive(page: string): boolean {
  return readLiveChoice(page) === true
}

export function writeLive(page: string, live: boolean): void {
  try {
    localStorage.setItem(liveKey(page), live ? "1" : "0")
  } catch {}
}
