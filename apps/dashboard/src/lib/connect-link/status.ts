import type { ConnectLinkSummary } from "@eccos/gateway-contract";

/** Where a connection link stands, as its dialog says it. */
export function linkStatusLine(link: ConnectLinkSummary): string {
  switch (link.state) {
    case "pending":
      return "Not opened yet";
    case "opened":
      return "Opened, not finished";
    case "connected":
      return link.connectedPhone ? `Connected ${link.connectedPhone}` : "Connected";
    case "unconfirmed":
      return "Used, but the result was not confirmed. Check Numbers.";
    case "expired":
      return "Expired";
  }
}

/** A link somebody may still be about to use. */
export function linkIsLive(link: ConnectLinkSummary): boolean {
  return link.state === "pending" || link.state === "opened";
}
