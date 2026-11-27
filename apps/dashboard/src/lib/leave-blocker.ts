/**
 * The router blocker for a page holding unsent work: the browser's leave-page
 * warning, and a block on in-app navigation to another path. A change of the
 * search (a tab, a step) stays on the same page and is never a departure.
 */
export function leaveBlocker(guarded: boolean) {
  return {
    shouldBlockFn: ({ current, next }: { current: { pathname: string }; next: { pathname: string } }) =>
      guarded && current.pathname !== next.pathname,
    enableBeforeUnload: guarded,
    withResolver: true as const,
  };
}
