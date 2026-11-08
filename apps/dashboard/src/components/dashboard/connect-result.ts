import type { ConnectExchangeResult } from "@eccos/gateway-contract";
import type { AnalyticsEventMap } from "../../lib/analytics";
import { CONNECT_FAILURES } from "./connect-outcome";

export type ConnectResultOutcome = AnalyticsEventMap["connect_outcome"]["result"];

/** What the connect view does with an Embedded Signup exchange. */
export type ConnectVerdict =
  | { connected: true; provisioningFailed?: true }
  | { connected: false; outcome: ConnectResultOutcome; message: string };

/** Shown when the customer closes Meta's window without finishing. Not an error. */
export const CONNECT_CANCELLED_MESSAGE =
  "The Meta window was closed before a number was connected. Nothing changed. Start again when you are ready.";

const NO_NUMBER_MESSAGE =
  "Meta finished, but no phone number was added to this WhatsApp Business Account. Start again and add a number in the Meta window.";

/**
 * Connected means at least one number was registered. Failed provisioning still
 * lands on /numbers, never a retry: the usual cause is a refused coexistence
 * sync, and running Embedded Signup again would re-onboard the number. The
 * operator recovers it from the failed row (docs/operations.md, "Coexistence
 * sync failures"). Anything that registered no number is told to the customer.
 */
export function judgeExchange(result: ConnectExchangeResult): ConnectVerdict {
  if (!result.ok) {
    return { connected: false, outcome: result.code, message: CONNECT_FAILURES[result.code] };
  }
  if (result.connected.length === 0) {
    return { connected: false, outcome: "no_number", message: NO_NUMBER_MESSAGE };
  }
  if (result.status === "failed") return { connected: true, provisioningFailed: true };
  return { connected: true };
}
