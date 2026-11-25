import { isRedirect } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

export const POLL_MS = 3_000;

/**
 * Runs `read` now and every `intervalMs` while `active`, one read at a time.
 * A thrown read is skipped and the next tick tries again; a sign-in redirect
 * stops the poll and is left to the root's unhandled-rejection net.
 */
export function usePoll(read: () => Promise<void>, active: boolean, intervalMs = POLL_MS): void {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await latest.current();
      } catch (err) {
        if (isRedirect(err)) throw err;
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, intervalMs]);
}
