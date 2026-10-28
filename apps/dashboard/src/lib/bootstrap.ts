/**
 * The root's scope read (`getDashboardState`), shared by the navigation guard
 * and the root loader so one navigation costs one request. Lives on the router
 * instance (router context), so on the server it is request-local — never a
 * module-level cache.
 */
export interface Bootstrap<T> {
  /** Guard side: join a read already started for this scope, or start one. */
  read(wabaId: string | undefined): Promise<T>
  /** Loader side: consume the guard's read, or start a fresh one. */
  take(wabaId: string | undefined): Promise<T>
}

/** A guard's read that no loader claimed (the guard redirected) expires. */
const HANDOFF_MS = 5_000

export function createBootstrap<T>(
  load: (wabaId: string | undefined) => Promise<T>,
  now: () => number = Date.now,
): Bootstrap<T> {
  const reads = new Map<string, { promise: Promise<T>; at: number }>()
  const live = (key: string) => {
    const entry = reads.get(key)
    return entry && now() - entry.at < HANDOFF_MS ? entry : undefined
  }
  return {
    read(wabaId) {
      const key = wabaId ?? ""
      const hit = live(key)
      if (hit) return hit.promise
      const entry = { promise: load(wabaId), at: now() }
      reads.set(key, entry)
      entry.promise.catch(() => {
        if (reads.get(key) === entry) reads.delete(key)
      })
      return entry.promise
    },
    take(wabaId) {
      const key = wabaId ?? ""
      const hit = live(key)
      reads.delete(key)
      return hit ? hit.promise : load(wabaId)
    },
  }
}
