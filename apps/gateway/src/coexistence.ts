/**
 * Coexistence onboarding policy (eccos-vss).
 *
 * A number onboarded through Embedded Signup with
 * `featureType: "whatsapp_business_app_onboarding"` keeps living in the
 * customer's WhatsApp Business app; Meta calls this *coexistence*. For that
 * flow — and only that flow — a Tech Provider owes Meta two extra actions after
 * the handoff, on top of the `subscribed_apps` subscription the saga already
 * performs:
 *
 *  1. initiate **contacts synchronisation**, and
 *  2. initiate **message-history synchronisation within 24 hours**.
 *
 * Meta's stated remedy for missing the 24-hour window is that the customer must
 * be **offboarded** — there is no "sync it later". That makes the deadline a
 * piece of durable state, not a comment: a WABA whose window has closed is a
 * WABA an operator has to act on, and it must never be indistinguishable from a
 * fully provisioned one.
 *
 * Meta also allows each sync **exactly once** per phone number, and answers a
 * duplicate with error `2593107` — whose remedy is, again, offboarding. That
 * turns the usual saga instinct on its head: the dangerous move here is not
 * giving up too early but trying again, so the states below distinguish "issued"
 * from "confirmed", and an issued-but-unanswered sync is terminal.
 *
 * This module is pure (no I/O, no Meta, no storage) so the whole policy is
 * testable on its own; the HTTP shape lives in `src/meta/smb-app-data.ts`.
 *
 * **Contacts are never stored.** The step *initiates* the contacts sync because
 * Meta's onboarding requires it, and that is all it does: nothing here, and
 * nothing downstream of here, persists a contact name or number. Eccos's data
 * lifecycle is events that age out at 30/90 days, and a contact book has no
 * honest retention answer inside it — pruned it is useless, kept it falsifies
 * the privacy policy — while the data subjects in it never messaged the
 * business at all. The state this module governs is provisioning state about a
 * WABA (what was initiated, when, and by when it must be), never a phonebook.
 */

/**
 * How a WABA came to be registered. `coexistence` means the WhatsApp Business
 * app onboarding flow; `standard` is every other path (the admin registration
 * endpoint, and any future ordinary Cloud API onboarding).
 *
 * Recorded per WABA rather than per phone because that is the granularity the
 * provisioning saga leases and retries on, and because `/connect` registers
 * exactly the numbers of one onboarding handoff.
 *
 * Caveat worth knowing: this records the onboarding Eccos *requested*, since
 * `/connect` hardcodes `featureType: "whatsapp_business_app_onboarding"`. Meta
 * exposes the onboarding it actually performed on the phone number itself
 * (`GET /<PHONE_NUMBER_ID>?fields=is_on_biz_app,platform_type`), which is the
 * authoritative signal and is not consulted here.
 */
export type WabaOnboardingType = "standard" | "coexistence";

export const WABA_ONBOARDING_TYPES: readonly WabaOnboardingType[] = [
  "standard",
  "coexistence",
];

export function isWabaOnboardingType(value: unknown): value is WabaOnboardingType {
  return value === "standard" || value === "coexistence";
}

/**
 * Where a WABA stands on the coexistence synchronisation Meta requires.
 *
 * - `not_applicable` — not a coexistence onboarding; nothing is owed.
 * - `pending` — owed, not yet initiated, and the window is still open.
 * - `initiated` — both contacts and message history have been initiated.
 * - `expired` — the 24-hour window closed with the history sync not initiated.
 *   Terminal: Meta's remedy is offboarding the customer.
 */
export type CoexistenceSyncStatus =
  | "not_applicable"
  | "pending"
  | "initiated"
  | "unconfirmed"
  | "expired";

/**
 * Durable coexistence state of one WABA.
 *
 * The two timestamps are `*StartedAt`, not `*SyncedAt`, and the distinction is
 * the whole safety property. Meta allows each sync exactly once per phone
 * number; a second attempt is error `2593107` and costs the customer their
 * onboarding. So the moment Eccos is *about to* call is the moment it records —
 * before the request goes out — and a recorded start is never re-attempted,
 * whatever the response was or failed to be. Acceptance is the separate fact,
 * carried by the request id Meta returns.
 */
export interface CoexistenceState {
  onboardingType: WabaOnboardingType;
  status: CoexistenceSyncStatus;
  /** Epoch ms by which message history must have been initiated; null when nothing is owed. */
  deadlineAt: number | null;
  /** Epoch ms the contacts sync request was *issued*; null while it never has been. */
  contactsStartedAt: number | null;
  /** Meta's support reference for the accepted contacts sync, or null. */
  contactsRequestId: string | null;
  /** Epoch ms the message-history sync request was *issued*; null while it never has been. */
  historyStartedAt: number | null;
  /** Meta's support reference for the accepted history sync, or null. */
  historyRequestId: string | null;
  /** Last failure reason for the sync step, or null. */
  error: string | null;
}

/**
 * Meta's window: message-history synchronisation must be initiated within 24
 * hours of the coexistence onboarding, otherwise the customer must be
 * offboarded.
 */
export const HISTORY_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Leave the last stretch of the window to the operator rather than to a retry.
 *
 * Spending the single allowed call at 23h59m is a coin flip: it has to reach
 * Meta *and* be accepted before the window shuts, there is no second try, and
 * nothing is left afterwards but offboarding. Past this margin the step stops
 * and hands the operator an explicit failure while there is still time to act.
 */
export const HISTORY_SYNC_DEADLINE_MARGIN_MS = 30 * 60 * 1000;

/** Deadline for a coexistence onboarding that happened at `onboardedAt`. */
export function historySyncDeadline(onboardedAt: number): number {
  return onboardedAt + HISTORY_SYNC_WINDOW_MS;
}

/** True once the window has closed — nothing can be initiated any more. */
export function historySyncWindowExpired(
  deadlineAt: number | null,
  now: number,
): boolean {
  return deadlineAt !== null && now >= deadlineAt;
}

/**
 * True while enough of the window is left to be worth spending the one allowed
 * call. A missing deadline is treated as "no window", i.e. always worth it — the
 * caller only reaches this for a coexistence WABA, which always has one.
 */
export function historySyncWorthAttempting(
  deadlineAt: number | null,
  now: number,
): boolean {
  if (deadlineAt === null) return true;
  return now < deadlineAt - HISTORY_SYNC_DEADLINE_MARGIN_MS;
}

/** Milliseconds left in the window; 0 once it has closed. */
export function historySyncTimeRemainingMs(
  deadlineAt: number | null,
  now: number,
): number {
  if (deadlineAt === null) return 0;
  return Math.max(0, deadlineAt - now);
}

/**
 * The one message an operator has to be able to act on: the window is gone and
 * Meta's remedy is offboarding. Kept as an exported constant so the console, the
 * tests and the runbook all quote the same words.
 */
export const HISTORY_SYNC_EXPIRED_ERROR =
  "coexistence message-history sync window expired (24h); Meta requires offboarding this customer and onboarding it again";

/**
 * The other terminal outcome, and the reason it is terminal.
 *
 * Meta allows each sync exactly once. Once a request has been issued, no answer
 * — a 5xx, a timeout, a dropped connection — proves Meta did not process it, and
 * a retry that turns out to be a duplicate is error `2593107`, which breaks the
 * onboarding for good. A lost `200` left alone costs nothing; the same lost
 * `200` retried costs the customer everything. So the step stops, and says so.
 */
export const SYNC_UNCONFIRMED_ERROR =
  "coexistence sync was issued but not confirmed by Meta and cannot be safely retried (each sync is allowed once); offboard this customer and onboard it again";

/**
 * Raised (and never retried) when the window has closed, or has so little left
 * that spending the one allowed call would be a gamble. Distinct from a
 * transport failure so
 * the saga can mark it terminal instead of backing off into the deadline.
 */
export class HistorySyncWindowExpiredError extends Error {
  readonly deadlineAt: number;
  /** True when the window is genuinely over, false when it is only past the retry margin. */
  readonly closed: boolean;

  constructor(deadlineAt: number, closed: boolean) {
    super(HISTORY_SYNC_EXPIRED_ERROR);
    this.name = "HistorySyncWindowExpiredError";
    this.deadlineAt = deadlineAt;
    this.closed = closed;
  }
}

/**
 * The coexistence status a WABA should carry, given what has been issued, what
 * Meta confirmed, and where the clock is. Pure, so the saga and the storage
 * layer cannot disagree about what "done" means.
 *
 * The order of the checks is the policy:
 *  - both confirmed → `initiated`, permanently, even long past the deadline:
 *    the deadline is about *initiating* the sync, and having done it in time
 *    cannot be undone by the clock moving on;
 *  - anything issued but unconfirmed → `unconfirmed`, terminal, because the
 *    once-only rule forbids trying again;
 *  - nothing issued and the window gone → `expired`;
 *  - otherwise still `pending`.
 */
export function coexistenceSyncStatus(input: {
  onboardingType: WabaOnboardingType;
  contactsStartedAt: number | null;
  contactsRequestId: string | null;
  historyStartedAt: number | null;
  historyRequestId: string | null;
  deadlineAt: number | null;
  now: number;
}): CoexistenceSyncStatus {
  if (input.onboardingType !== "coexistence") return "not_applicable";
  const contactsDone = input.contactsRequestId !== null;
  const historyDone = input.historyRequestId !== null;
  if (contactsDone && historyDone) return "initiated";
  const spentUnconfirmed =
    (input.contactsStartedAt !== null && !contactsDone) ||
    (input.historyStartedAt !== null && !historyDone);
  if (spentUnconfirmed) return "unconfirmed";
  if (historySyncWindowExpired(input.deadlineAt, input.now)) return "expired";
  return "pending";
}

/**
 * May the saga still issue a sync for this WABA?
 *
 * False for a non-coexistence onboarding (it owes nothing), for one already
 * fully synchronised, and — critically — for one that has already issued a
 * request without confirmation. That last case is what keeps the once-only rule:
 * a spent sync is never re-attempted, so no retry can ever turn into Meta's
 * `2593107`.
 */
export function coexistenceSyncOutstanding(state: {
  onboardingType: WabaOnboardingType;
  contactsStartedAt: number | null;
  contactsRequestId: string | null;
  historyStartedAt: number | null;
  historyRequestId: string | null;
}): boolean {
  if (state.onboardingType !== "coexistence") return false;
  const pendingContacts = state.contactsStartedAt === null;
  const pendingHistory = state.historyStartedAt === null;
  return pendingContacts || pendingHistory;
}

/**
 * True when a request was issued and never confirmed — the state that must fail
 * the WABA terminally rather than back off into another attempt.
 */
export function coexistenceSyncSpentUnconfirmed(state: {
  onboardingType: WabaOnboardingType;
  contactsStartedAt: number | null;
  contactsRequestId: string | null;
  historyStartedAt: number | null;
  historyRequestId: string | null;
}): boolean {
  if (state.onboardingType !== "coexistence") return false;
  return (
    (state.contactsStartedAt !== null && state.contactsRequestId === null) ||
    (state.historyStartedAt !== null && state.historyRequestId === null)
  );
}

/**
 * Raised when a sync has been spent without confirmation. Terminal by
 * construction: there is no attempt left to make.
 */
export class SyncUnconfirmedError extends Error {
  constructor() {
    super(SYNC_UNCONFIRMED_ERROR);
    this.name = "SyncUnconfirmedError";
  }
}
