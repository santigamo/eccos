import { rootRouteId } from "@tanstack/react-router"

interface Invalidator {
  invalidate(opts: { filter: (match: { routeId: string }) => boolean }): Promise<unknown>
}

/**
 * Router invalidation is always targeted. The root holds the bootstrap (stage,
 * scope, forwarding flag) and is reloaded only by events that can change it:
 * workspace created, connect/provisioning done, WABA removed, forwarding edit.
 * Everything else (polling, retries, sends, template writes) refreshes pages.
 */
export const invalidatePage = (router: Invalidator) =>
  router.invalidate({ filter: (m) => m.routeId !== rootRouteId })

export const invalidateRoutes = (router: Invalidator, ...routeIds: string[]) =>
  router.invalidate({ filter: (m) => routeIds.includes(m.routeId) })

export { rootRouteId }
