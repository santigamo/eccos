import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** False on the server and through hydration, true after: for what only the browser knows (its time zone). */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
