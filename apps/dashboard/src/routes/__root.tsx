import { useEffect, type ReactNode } from "react"
import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router"
import { AppShell } from "../components/blocks/app-shell-7/components/app-shell"
import { getDashboardScope } from "../server/gateway"

import appCss from "../app.css?url"

type ScopeSearch = { wabaId?: string }

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): ScopeSearch => ({
    ...(typeof search.wabaId === "string" && search.wabaId.trim() !== ""
      ? { wabaId: search.wabaId.trim() }
      : {}),
  }),
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: ({ deps }) => getDashboardScope({ data: { wabaId: deps.wabaId } }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Eccos — Operator Console" },
      { name: "theme-color", content: "#070c0f" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "preload",
        href: "/assets/fonts/InterVariable.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/assets/fonts/GeistPixel-Square.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      { rel: "icon", href: "/assets/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/assets/favicon-32.png", type: "image/png", sizes: "32x32" },
      { rel: "icon", href: "/assets/favicon-16.png", type: "image/png", sizes: "16x16" },
      { rel: "apple-touch-icon", href: "/assets/avatar.png" },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <AppShell />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-background focus:text-foreground focus:border focus:border-ring focus:text-sm"
        >
          Skip to main content
        </a>
        <CursorLight />
        {children}
        <Scripts />
      </body>
    </html>
  )
}

/**
 * The lantern (see #cursor-light in app.css). The trailing lerp is what makes
 * it read as "lighting the way" rather than a cursor decoration. The rAF loop
 * parks itself while the light has caught up and the pointer is still.
 */
function CursorLight() {
  useEffect(() => {
    const el = document.getElementById("cursor-light")
    if (!el) return
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      window.matchMedia("(pointer: coarse)").matches
    ) {
      return
    }

    const HALF = 600 // half the element's 1200px box
    let targetX = 0
    let targetY = 0
    let x = 0
    let y = 0
    let raf = 0
    let running = false
    let lit = false

    const tick = () => {
      x += (targetX - x) * 0.08
      y += (targetY - y) * 0.08
      el.style.transform = `translate3d(${x - HALF}px, ${y - HALF}px, 0)`
      if (Math.abs(targetX - x) + Math.abs(targetY - y) < 0.5) {
        running = false
        return
      }
      raf = requestAnimationFrame(tick)
    }

    const onMove = (e: MouseEvent) => {
      targetX = e.clientX
      targetY = e.clientY
      if (!lit) {
        lit = true
        x = targetX
        y = targetY
        el.style.opacity = "1"
      }
      if (!running) {
        running = true
        raf = requestAnimationFrame(tick)
      }
    }

    window.addEventListener("mousemove", onMove, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("mousemove", onMove)
    }
  }, [])

  return <div id="cursor-light" aria-hidden="true" />
}
