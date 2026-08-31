/**
 * Meta SMB App Data API — coexistence contacts and message-history sync.
 *
 * Source (read 2026-08-31): "Onboard WhatsApp Business app users",
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
 * (updated 2026-06-26). Meta serves a raw-markdown twin of every page in that
 * tree by appending `.md`, which is how the contract below was read verbatim —
 * the older `/docs/.../reference/smb-app-data` URL Meta's own guide links to is
 * a 404 and has never been reachable, so this guide is the only primary source.
 *
 * The contract, quoted from the two curl examples on that page:
 *
 *     POST https://graph.facebook.com/<API_VERSION>/<BUSINESS_PHONE_NUMBER_ID>/smb_app_data
 *     Content-Type: application/json
 *     {"messaging_product": "whatsapp", "sync_type": "smb_app_state_sync"}   // contacts
 *     {"messaging_product": "whatsapp", "sync_type": "history"}              // messages
 *
 *     200 {"messaging_product": "whatsapp", "request_id": "<REQUEST_ID>"}
 *
 * The node is the **business phone number id**, not the WABA id.
 *
 * ── THIS ENDPOINT IS NOT RETRY-SAFE ──────────────────────────────────────────
 * Meta, on the same page, for each of the two steps: *"You can only perform this
 * step once. If you need to perform it again, the customer must first offboard,
 * then complete the Embedded Signup flow again."* A second call of the same
 * `sync_type` returns error `2593107`, whose documented remedy is offboarding
 * the customer. So a caller must record that it is about to make the call
 * *before* making it, and must never re-issue one it has already sent — even
 * after a timeout, and especially after a 5xx. A lost `200` costs nothing if
 * left alone and costs the customer their onboarding if retried.
 * `src/provisioning.ts` is what enforces that; this module only sends.
 *
 * Two more documented facts the caller depends on:
 *   - `2593108` — "Synchronization request can only be made within 24 hours of
 *     onboarding". The machine-readable form of the deadline in `coexistence.ts`.
 *   - A 200 on the history call means the request was *accepted*, not that
 *     history will arrive: Meta says so explicitly, and a business that turned
 *     history sharing off surfaces later as `2593109` on the `history` webhook.
 *
 * NO CONTACT IS EVER STORED. These functions ask Meta to start synchronising and
 * read nothing back but an acceptance and a support reference id.
 */

import { graphBaseUrl, type CoreConfig } from "@eccos/core/config-schema";
import { MetaGraphError } from "./connect-api";

type MetaGraphConfig = Pick<CoreConfig, "META_GRAPH_VERSION">;

/**
 * The Graph edge these calls post to. Exported so tests can route a mock by URL
 * without repeating the path.
 */
export const SMB_APP_DATA_EDGE = "smb_app_data";

/** What a sync request asks Meta to synchronise. */
export type SmbAppDataSyncType = "contacts" | "history";

/** Meta's `sync_type` values, verbatim from the onboarding guide's curl examples. */
export const SMB_APP_DATA_SYNC_TYPE: Record<SmbAppDataSyncType, string> = {
  contacts: "smb_app_state_sync",
  history: "history",
};

/** Meta error code: this sync was already performed for this phone number. */
export const SMB_APP_DATA_ALREADY_SYNCED_CODE = 2593107;
/** Meta error code: the request came more than 24 hours after onboarding. */
export const SMB_APP_DATA_WINDOW_CLOSED_CODE = 2593108;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Meta's own example documents `{messaging_product, request_id}` and tells the
 * caller to *"Store the `request_id` value in case you need to contact
 * support."* Third-party clients additionally expect a `success` boolean that
 * Meta never documents, so acceptance is judged on the HTTP status and the
 * absence of an `error` object — never on a field that may not exist. A missing
 * `request_id` is not treated as a failure for the same reason.
 */
export interface SmbAppDataSyncAccepted {
  /** Meta's support reference for this sync request, when it supplied one. */
  requestId: string | null;
}

/**
 * The single call. Every coexistence sync goes through here.
 *
 * Throws `MetaGraphError` on a non-2xx, carrying the HTTP status. The caller
 * must treat *any* throw as "this sync is spent": a rejected promise does not
 * prove Meta never processed the request.
 */
async function postSmbAppDataSync(
  cfg: MetaGraphConfig,
  phoneNumberId: string,
  token: string,
  syncType: SmbAppDataSyncType,
): Promise<SmbAppDataSyncAccepted> {
  const res = await fetch(
    `${graphBaseUrl(cfg)}/${encodeURIComponent(phoneNumberId)}/${SMB_APP_DATA_EDGE}`,
    {
      method: "POST",
      headers: {
        // Meta's example for this endpoint omits the `Bearer` prefix while the
        // very next example on the same page includes it; every other Graph call
        // in Eccos sends `Bearer`, and so does every third-party implementation
        // of this one. Treated as a documentation typo.
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        sync_type: SMB_APP_DATA_SYNC_TYPE[syncType],
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const error = asRecord(asRecord(json)?.error);
    const message = typeof error?.message === "string" ? error.message : null;
    throw new MetaGraphError(`${SMB_APP_DATA_EDGE} ${syncType}`, res.status, message);
  }
  const requestId = asRecord(json)?.request_id;
  return { requestId: typeof requestId === "string" && requestId !== "" ? requestId : null };
}

/**
 * Initiate contacts synchronisation for a coexistence number.
 *
 * Eccos initiates it because Meta's onboarding requires it, and does nothing
 * else with it: no contact reaches Eccos storage, now or later.
 */
export function initiateContactsSync(
  cfg: MetaGraphConfig,
  phoneNumberId: string,
  token: string,
): Promise<SmbAppDataSyncAccepted> {
  return postSmbAppDataSync(cfg, phoneNumberId, token, "contacts");
}

/**
 * Initiate message-history synchronisation for a coexistence number. This is the
 * call bound by Meta's 24-hour window.
 */
export function initiateHistorySync(
  cfg: MetaGraphConfig,
  phoneNumberId: string,
  token: string,
): Promise<SmbAppDataSyncAccepted> {
  return postSmbAppDataSync(cfg, phoneNumberId, token, "history");
}
