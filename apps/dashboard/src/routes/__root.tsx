import { useEffect, type ReactNode } from "react"
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
  redirect,
  useLocation,
} from "@tanstack/react-router"
import { AppShell } from "../components/blocks/app-shell-7/components/app-shell"
import { getDashboardState } from "../server/gateway"
import { getSessionUser } from "../organizations"
import { normalizeSearchWabaId } from "../lib/search"
import appCss from "../app.css?url"

type ScopeSearch = { wabaId?: string }

/**
 * Routes that resolve no WABA scope of their own, so the "connect a number
 * first" bounce must not eat them. /numbers is where that bounce sends people;
 * /workspaces/new is about the workspace itself, and an operator whose current
 * workspace has no number yet is exactly the one who may want another.
 */
const SCOPE_FREE_PATHS = new Set(["/numbers", "/workspaces/new"])

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): ScopeSearch => {
    const wabaId = normalizeSearchWabaId(search.wabaId)
    return wabaId ? { wabaId } : {}
  },
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: async ({ deps, location }) => {
    // Page-level auth gate lives in the SERVER ENTRY (src/server.ts): it runs
    // before routing for every request, so anonymous page loads are redirected
    // to /signin before this loader executes. Server functions fail closed in
    // src/auth/server-auth.ts. Public routes are also handled there.
    const state = await getDashboardState({ data: { wabaId: deps.wabaId } })
    if (state.ok && state.data.stage === "no-organization" && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" })
    }
    // /onboarding is FIRST RUN only, and stays that way: an account that
    // already has a workspace must not land back on the step it completed.
    // Creating an ADDITIONAL workspace is a different situation and has its own
    // in-shell entry point (/workspaces/new) — see that route for the argument.
    if (state.ok && state.data.stage === "ready" && location.pathname === "/onboarding") {
      throw redirect({ to: "/" })
    }
    // An account with no WABA yet stays inside the app chrome and lands on
    // /numbers, whose empty state is the connect flow. Every other route needs
    // a WABA to resolve its scope, so they bounce here rather than rendering a
    // "gateway unreachable" card that would blame the wrong thing.
    if (
      state.ok &&
      state.data.stage !== "ready" &&
      state.data.stage !== "no-organization" &&
      !SCOPE_FREE_PATHS.has(location.pathname)
    ) {
      throw redirect({ to: "/numbers" })
    }
    // Display identity for the sidebar's account section. Deduped with the
    // loader's own session read by the request-scoped memo.
    const user = await getSessionUser()
    return { ...state, user }
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Eccos — Operator Console" },
      { name: "theme-color", content: "#070c0f" },
      // Everything below is for LINK UNFURLS — what Slack, iMessage, WhatsApp
      // and the like render when someone pastes an app.eccos.chat URL. Without
      // a description and an og:image the unfurl is a bare hostname, which
      // reads as a broken or untrusted link precisely where an operator is
      // sharing the console with a colleague.
      //
      // Safe to serve on every route because it is STATIC: the same four
      // strings on /signin and on a deep tenant page. No loader data reaches
      // this head, so an unfurl can never leak a workspace name, a number, or
      // anything else scoped to whoever happened to render the page — and an
      // unfurler is unauthenticated anyway, so it only ever sees the sign-in
      // shell.
      {
        name: "description",
        content:
          "Connect WhatsApp numbers, follow deliveries, and manage templates and keys for your Eccos gateway.",
      },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Eccos" },
      { property: "og:title", content: "Eccos — Operator Console" },
      {
        property: "og:description",
        content:
          "Connect WhatsApp numbers, follow deliveries, and manage templates and keys for your Eccos gateway.",
      },
      { property: "og:url", content: "https://app.eccos.chat/" },
      // Absolute, and served from THIS origin rather than pointing at the
      // landing's copy: an unfurler resolves og:image on its own, and a
      // cross-host reference would make the console's preview break silently
      // whenever the site reorganises its assets.
      { property: "og:image", content: "https://app.eccos.chat/assets/banner.jpg" },
      { property: "og:image:alt", content: "Eccos" },
      { name: "twitter:card", content: "summary_large_image" },
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
      // 180x180 and at the WELL-KNOWN ROOT PATH, together with /favicon.ico.
      // Both are real files in public/ for one reason: this is a single-page
      // app whose catch-all answers unmatched paths with the HTML shell, so a
      // fetcher asking for /apple-touch-icon.png used to get 200 text/html —
      // an image request satisfied with a document, which is worse than the
      // 404 it expects. Naive fetchers that probe the root paths without
      // parsing the head are the ones this is for; browsers were always fine,
      // because the link tags here are enough for them.
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  const state = Route.useLoaderData()
  const pathname = useLocation({ select: (l) => l.pathname })
  return (
    <RootDocument lanternExempt={LANTERN_EXEMPT_PATHS.has(pathname)}>
      {state.ok && state.data.stage !== "no-organization" ? (
        // Authenticated tenant context. The chrome wraps every state that has
        // an organization, including the one with no WABA yet: the user is
        // signed in, so they must be able to see who they are and sign out.
        <AppShell />
      ) : (
        // Unauthenticated (or gateway-unreachable) root load: bare outlet so
        // the sign-in screen renders WITHOUT the app chrome around it.
        <Outlet />
      )}
    </RootDocument>
  )
}

function RootDocument({
  children,
  lanternExempt,
}: Readonly<{ children: ReactNode; lanternExempt: boolean }>) {
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
        {lanternExempt ? null : <CursorLight />}
        {children}
        <Scripts />
      </body>
    </html>
  )
}

/** Pre-auth brand surfaces — the silk owns the spectacle there. */
const LANTERN_EXEMPT_PATHS = new Set([
  "/signin",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/invitations",
])

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
