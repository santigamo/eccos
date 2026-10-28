import type { Result } from "../server/gateway";

export interface ReadCache<T> {
  /** The last completed read, at any age: enough to paint while a fresh one loads. */
  peek: (key: string) => T | undefined;
  /**
   * Single-flight read: joins one in flight, reuses a completed one younger
   * than the TTL, otherwise loads. `force` always loads (after a mutation) and
   * supersedes whatever was in flight. Failures are never kept.
   */
  read: (key: string, load: () => Promise<Result<T>>, force?: boolean) => Promise<Result<T>>;
  /** A new generation: kept reads and in-flight ones are forgotten. */
  clear: () => void;
}

export function createReadCache<T>(ttlMs: number, maxEntries = 50, now: () => number = Date.now): ReadCache<T> {
  let generation = 0;
  const done = new Map<string, { at: number; data: T }>();
  const flying = new Map<string, Promise<Result<T>>>();
  const id = (key: string) => `${generation}:${key}`;

  return {
    peek: (key) => done.get(id(key))?.data,
    read(key, load, force = false) {
      const slot = id(key);
      if (!force) {
        const hit = done.get(slot);
        if (hit && now() - hit.at < ttlMs) return Promise.resolve({ ok: true, data: hit.data });
        const joined = flying.get(slot);
        if (joined) return joined;
      }
      const settle = () => {
        if (flying.get(slot) === request) flying.delete(slot);
      };
      const request: Promise<Result<T>> = load().then(
        (result) => {
          if (flying.get(slot) === request && result.ok) {
            done.delete(slot);
            done.set(slot, { at: now(), data: result.data });
            if (done.size > maxEntries) done.delete(done.keys().next().value as string);
          }
          settle();
          return result;
        },
        (err) => {
          settle();
          throw err;
        },
      );
      flying.set(slot, request);
      return request;
    },
    clear() {
      generation++;
      done.clear();
      flying.clear();
    },
  };
}
