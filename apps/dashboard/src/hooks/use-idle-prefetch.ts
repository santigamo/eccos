import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { NAV_MAIN } from "../components/blocks/app-shell-7/components/data";

/** Templates are listed from Meta's API: never spend that quota on a guess. */
const NEVER_IDLE = new Set(["/templates"]);

export interface IdleEnv {
  /** Calls `run` when the browser is idle; returns the cancel. */
  whenIdle: (run: () => void) => () => void;
  /** The tab is hidden or the user asked to save data. */
  skip: () => boolean;
}

const browserEnv: IdleEnv = {
  whenIdle(run) {
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(run, { timeout: 3_000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(run, 1_000);
    return () => clearTimeout(id);
  },
  skip: () =>
    document.visibilityState === "hidden" ||
    !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData,
};

/** The sidebar destinations whose scope requirement is met and that are safe to read ahead. */
export function idleRoutes(scope: { hasNumber: boolean; hasWaba: boolean }): string[] {
  return NAV_MAIN.flatMap((group) => group.items)
    .filter((item) => !NEVER_IDLE.has(item.href))
    .filter((item) => (item.requires === "number" ? scope.hasNumber : item.requires === "waba" ? scope.hasWaba : true))
    .map((item) => item.href);
}

let started = false;

/** Test seam: the document-wide "once" guard. */
export const resetIdlePrefetch = () => {
  started = false;
};

/**
 * Runs `tasks` one at a time once the browser is idle, at most once per
 * document. Stops at the first sign the tab is hidden or data saving is on; a
 * failed task never stops the rest.
 */
export function startIdlePrefetch(tasks: Array<() => Promise<unknown>>, env: IdleEnv = browserEnv): void {
  if (started || tasks.length === 0) return;
  started = true;
  env.whenIdle(async () => {
    for (const task of tasks) {
      if (env.skip()) return;
      await task().catch(() => {});
    }
  });
}

/** Warms the sidebar destinations the operator can open, once the first page is interactive. */
export function useIdlePrefetch(scope: { hasNumber: boolean; hasWaba: boolean }, wabaId: string | undefined): void {
  const router = useRouter();
  const { hasNumber, hasWaba } = scope;
  useEffect(() => {
    startIdlePrefetch(
      idleRoutes({ hasNumber, hasWaba }).map((to) => () =>
        router.state.location.pathname === to ? Promise.resolve() : router.preloadRoute({ to, search: { wabaId } } as never),
      ),
    );
  }, [router, hasNumber, hasWaba, wabaId]);
}

/** Runs `run` when the browser is idle (skipped when hidden or saving data); cancelled on cleanup. */
export function useWhenIdle(run: () => void, deps: unknown[], env: IdleEnv = browserEnv): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's trigger
  useEffect(() => env.whenIdle(() => env.skip() || run()), deps);
}
