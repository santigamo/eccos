import type { AccountWabaResource, CoexistenceResource } from "@eccos/gateway-contract";

/**
 * What a customer reads about a number's provisioning, keyed on structured
 * state (status, coexistence status, the sync request ids), never on the
 * gateway's `provisioningError` / `coexistence.error`: those sentences are
 * written for operators and stay in the logs and docs/operations.md.
 *
 * Only an operator can act on these, so they point to Eccos support rather than
 * promising a notification nobody sends.
 */

const UNAVAILABLE_REASON = /^unavailable:(already_synced|history_sharing_off|not_permitted)$/;

const SYNC_NOUN = {
  contacts: "Your WhatsApp Business app contacts were",
  history: "Your WhatsApp Business app chat history was",
} as const;

const REASON_COPY = {
  already_synced:
    "not imported: Meta allows that import once per number, and it was already used. To repeat the import, contact Eccos support.",
  history_sharing_off:
    "not imported: history sharing was off when the number was connected. To run the import, contact Eccos support.",
  not_permitted: "not imported: Meta did not allow it for this number. Contact Eccos support.",
} as const;

/** One sentence per sync Meta refused. */
export function syncUnavailableCopy(coexistence: CoexistenceResource): string[] {
  const lines = (["contacts", "history"] as const).flatMap((kind) => {
    const requestId = kind === "contacts" ? coexistence.contactsRequestId : coexistence.historyRequestId;
    const reason = requestId?.match(UNAVAILABLE_REASON)?.[1] as keyof typeof REASON_COPY | undefined;
    return reason ? [`${SYNC_NOUN[kind]} ${REASON_COPY[reason]}`] : [];
  });
  return lines.length > 0 ? lines : ["Some WhatsApp Business app data was not imported. Contact Eccos support."];
}

/**
 * Why a failed WABA is not connected, and what to do. A `failed` WABA neither
 * sends nor forwards, so none of this says the number works.
 */
export function failedWabaCopy(waba: Pick<AccountWabaResource, "coexistence">): string {
  switch (waba.coexistence.status) {
    case "unconfirmed":
      return "This number is not connected: Eccos could not confirm that your WhatsApp Business app contacts and chat history were imported. Contact Eccos support.";
    case "expired":
      return "This number is not connected: the 24-hour window to import your WhatsApp Business app chat history ran out. Contact Eccos support.";
    default:
      return "Eccos could not finish connecting this number. Connect it again; if it still fails, contact Eccos support.";
  }
}
