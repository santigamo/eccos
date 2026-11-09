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

/** The notice after a Re-check that left the WABA not active. */
export function recheckNotice(status: string): string {
  return status === "failed"
    ? "This number could not be connected. See Connection failed above."
    : "Meta has not confirmed the subscription yet. Eccos will keep retrying.";
}

const SYNC_NAME = { contacts: "contacts", history: "chat history" } as const;

/** The syncs Eccos requested and Meta never answered. */
function unconfirmedSyncs({ coexistence }: Pick<AccountWabaResource, "coexistence">): string {
  const names = [
    coexistence.contactsStartedAt !== null && coexistence.contactsRequestId === null ? SYNC_NAME.contacts : null,
    coexistence.historyStartedAt !== null && coexistence.historyRequestId === null ? SYNC_NAME.history : null,
  ].filter((name) => name !== null);
  return names.length > 0 ? names.join(" and ") : "contacts and chat history";
}

/**
 * Why a failed WABA is not connected, and what to do. A `failed` WABA neither
 * sends nor forwards, so none of this says the number works.
 *
 * Once a once-only sync was requested, connecting again would re-issue it and
 * destroy the evidence, so those states point to support only. That includes a
 * failed WABA whose coexistence status still reads `pending` or `unavailable`.
 */
export function failedWabaCopy(waba: Pick<AccountWabaResource, "coexistence" | "phones">): string {
  const subject = waba.phones.length > 0 ? "This number is" : "This account is";
  const { coexistence } = waba;
  if (coexistence.status === "expired") {
    return `${subject} not connected: the 24-hour window to import your WhatsApp Business app chat history ran out. Contact Eccos support.`;
  }
  if (coexistence.status === "unconfirmed") {
    return `${subject} not connected: Eccos could not confirm that your WhatsApp Business app ${unconfirmedSyncs(waba)} import finished. Contact Eccos support.`;
  }
  if (coexistence.contactsStartedAt !== null || coexistence.historyStartedAt !== null) {
    return `${subject} not connected: Eccos started importing your WhatsApp Business app data and could not finish. Contact Eccos support.`;
  }
  return `${subject} not connected yet: Eccos could not finish the setup. Connect it again; if it still fails, contact Eccos support.`;
}
