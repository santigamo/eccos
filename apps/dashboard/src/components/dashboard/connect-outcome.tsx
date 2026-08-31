import type { ConnectFailureCode } from "@eccos/gateway-contract";
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

/**
 * One sentence per outcome, in the console's own words. The gateway sends a
 * code, never a Graph error message: the wording is a product decision, and a
 * raw provider error has no business sitting in a URL.
 */
const CONNECT_FAILURES: Record<ConnectFailureCode, string> = {
  state: "That connection attempt expired before Meta answered. Start it again.",
  denied: "Meta ended the connection before a number was attached. Nothing changed here.",
  owned: "That WhatsApp Business Account is already connected to another Eccos workspace.",
  no_waba: "That Meta login has no WhatsApp Business Account yet. Create one, then connect again.",
  failed: "Meta could not complete the connection. Try again.",
};

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
              connectError ? "border-l-[#e03131]" : "border-l-[#f0a020]",
            )
          : undefined
      }
      aria-live="polite"
    >
      {detail}
    </output>
  );
}
