import type { ConnectExchangeResult } from "@eccos/gateway-contract";
import type { AnalyticsEventMap } from "../../lib/analytics";
import { CONNECT_FAILURES } from "./connect-outcome";

export type ConnectResultOutcome = AnalyticsEventMap["connect_outcome"]["result"];

/** What the connect view does with an Embedded Signup exchange. */
export type ConnectVerdict =
  | { connected: true }
  | { connected: false; outcome: ConnectResultOutcome; message: string };

/** Shown when the customer closes Meta's window without finishing. Not an error. */
export const CONNECT_CANCELLED_MESSAGE =
  "The Meta window was closed before a number was connected. Nothing changed. Start again when you are ready.";

const NO_NUMBER_MESSAGE =
  "Meta finished, but no phone number was added to this WhatsApp Business Account. Start again and add a number in the Meta window.";

const PROVISIONING_FAILED_MESSAGE =
  "Meta accepted the connection, but setting up the number here did not finish. Try again, and contact support if it keeps happening.";

/**
 * Connected means at least one number was registered and provisioning has not
 * failed: `pending` keeps provisioning on /numbers, `active` is done. Anything
 * else must be told to the customer instead of looking like success.
 */
export function judgeExchange(result: ConnectExchangeResult): ConnectVerdict {
  if (!result.ok) {
    return { connected: false, outcome: result.code, message: CONNECT_FAILURES[result.code] };
  }
  if (result.connected.length === 0) {
    return { connected: false, outcome: "no_number", message: NO_NUMBER_MESSAGE };
  }
  if (result.status === "failed") {
    return {
      connected: false,
      outcome: "provisioning_failed",
      message: PROVISIONING_FAILED_MESSAGE,
    };
  }
  return { connected: true };
}
