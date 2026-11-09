import { useSyncExternalStore } from "react"

/**
 * The console's theme, ported from the landing's site.js. Absent `data-theme`
 * means "follow the system"; "light" and "dark" are explicit overrides, and
 * only those two are ever stored.
 */

export type ThemeMode = "auto" | "light" | "dark"
export type EffectiveTheme = "light" | "dark"
export interface ThemeState {
  mode: ThemeMode
  effective: EffectiveTheme
}

export const THEME_STORAGE_KEY = "eccos-theme"

const LIGHT_QUERY = "(prefers-color-scheme: light)"
const THEME_COLOR: Record<EffectiveTheme, string> = { light: "#f7f9f8", dark: "#070c0f" }

/** What the server renders: the dark theme, until the client knows better. */
const SERVER_STATE: ThemeState = { mode: "auto", effective: "dark" }

const listeners = new Set<() => void>()
let snapshot = SERVER_STATE

function readState(): ThemeState {
  const attr = document.documentElement.getAttribute("data-theme")
  const mode: ThemeMode = attr === "light" || attr === "dark" ? attr : "auto"
  const effective = mode === "auto" ? (window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark") : mode
  return { mode, effective }
}

/** Keeps the same object while nothing changed, as useSyncExternalStore requires. */
function getSnapshot(): ThemeState {
  const next = readState()
  if (next.mode !== snapshot.mode || next.effective !== snapshot.effective) snapshot = next
  return snapshot
}

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(LIGHT_QUERY)
  listeners.add(listener)
  media.addEventListener("change", listener)
  return () => {
    listeners.delete(listener)
    media.removeEventListener("change", listener)
  }
}

/**
 * Overrides win over the metas' own media queries, so both carry the effective
 * colour; auto hands each meta back its own scheme's colour.
 */
export function syncThemeColor(): void {
  const attr = document.documentElement.getAttribute("data-theme")
  const forced = attr === "light" || attr === "dark" ? attr : undefined
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    const scheme: EffectiveTheme = meta.media === LIGHT_QUERY ? "light" : "dark"
    meta.content = THEME_COLOR[forced ?? scheme]
  })
}

export function setThemeMode(mode: ThemeMode): void {
  const root = document.documentElement
  if (mode === "auto") root.removeAttribute("data-theme")
  else root.setAttribute("data-theme", mode)
  try {
    if (mode === "auto") localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Storage is unavailable: the override still holds for this page.
  }
  syncThemeColor()
  listeners.forEach((listener) => listener())
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_STATE)
}
