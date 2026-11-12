import { useEffect } from "react";
import type { ConnectFailureCode } from "@eccos/gateway-contract";
import { track, whenUmamiReady } from "@/lib/analytics";
import { CONNECT_FAILURES } from "@/lib/connect-result";
import { cn } from "@/lib/utils";

/**
 * How Meta's Embedded Signup callback reports back to the console (eccos-5z9).
 * The gateway owns the callback and redirects here with a code; success carries
 * nothing at all, because the connected number appears in the table below and a
 * green banner would only be noise (docs/DASHBOARD-DESIGN.md, reporting rule 1).
 */
export type ConnectOutcomeSearch = {
  connectError?: ConnectFailureCode;
  connectSkipped?: number;
};

const CONNECT_FAILURE_CODES = new Set<string>([
  "state",
  "denied",
  "owned",
  "no_waba",
  "subscription_required",
  "failed",
]);

export function normalizeConnectError(value: unknown): ConnectFailureCode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return CONNECT_FAILURE_CODES.has(normalized) ? (normalized as ConnectFailureCode) : undefined;
}

export function normalizeConnectSkipped(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function skippedDetail(skipped: number): string {
  return skipped === 1
    ? "1 WhatsApp Business Account was skipped: it is already connected to another Eccos workspace."
    : `${skipped} WhatsApp Business Accounts were skipped: they are already connected to another Eccos workspace.`;
}

/**
 * Renders only when something is wrong, so a banner an operator sees always
 * means something. The live region stays mounted rather than appearing with the
 * message: an element that appears is not reliably announced, an empty one that
 * fills up is.
 */
export function ConnectOutcome({ connectError, connectSkipped }: ConnectOutcomeSearch) {
  // Counted once per gateway redirect: a reload or Back renders the same URL.
  // Success carries no parameter; it is tracked in `connect-number.tsx`.
  useEffect(() => {
    if (!connectError && !connectSkipped) return;
    if (revisitedDocument()) return;
    const result = connectError ?? "skipped";
    void whenUmamiReady().then((umami) => {
      if (umami) track("connect_outcome", { result });
    });
  }, [connectError, connectSkipped]);

  const detail = connectError
    ? CONNECT_FAILURES[connectError]
    : connectSkipped
      ? skippedDetail(connectSkipped)
      : null;
  return (
    <output
      className={
        detail
          ? cn(
              "mb-4 block border-l-2 px-3 py-2 text-sm text-foreground",
              connectError ? "border-l-destructive" : "border-l-warning",
            )
          : undefined
      }
      aria-live="polite"
    >
      {detail}
      {connectError === "subscription_required" ? (
        <>
          {" "}
          <a href="/settings" className="underline underline-offset-2">
            Open billing
          </a>
        </>
      ) : null}
    </output>
  );
}

/** Was this document reached by a reload or history traversal? */
function revisitedDocument(): boolean {
  try {
    const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return entry?.type === "reload" || entry?.type === "back_forward";
  } catch {
    return false;
  }
}
