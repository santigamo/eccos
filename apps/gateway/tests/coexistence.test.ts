import { describe, expect, test } from "bun:test";
import {
  HISTORY_SYNC_EXPIRED_ERROR,
  SYNC_UNCONFIRMED_ERROR,
  SyncUnconfirmedError,
  coexistenceSyncSpentUnconfirmed,
  HISTORY_SYNC_DEADLINE_MARGIN_MS,
  HISTORY_SYNC_WINDOW_MS,
  HistorySyncWindowExpiredError,
  coexistenceSyncOutstanding,
  coexistenceSyncStatus,
  historySyncDeadline,
  historySyncWorthAttempting,
  historySyncTimeRemainingMs,
  historySyncWindowExpired,
  isWabaOnboardingType,
  COEXISTENCE_PLATFORM_TYPE,
  verifiedOnboardingTypeFrom,
} from "../src/coexistence";

const ONBOARDED_AT = 1_800_000_000_000;
const DEADLINE = ONBOARDED_AT + HISTORY_SYNC_WINDOW_MS;

describe("coexistence deadline policy (eccos-vss)", () => {
  test("the window Meta gives is exactly 24 hours from the onboarding", () => {
    expect(HISTORY_SYNC_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(historySyncDeadline(ONBOARDED_AT)).toBe(DEADLINE);
  });

  test("the window is open right up to the deadline and shut on it", () => {
    expect(historySyncWindowExpired(DEADLINE, DEADLINE - 1)).toBe(false);
    // Inclusive: at the deadline the window is gone, not "just about to go".
    expect(historySyncWindowExpired(DEADLINE, DEADLINE)).toBe(true);
    expect(historySyncWindowExpired(DEADLINE, DEADLINE + 1)).toBe(true);
  });

  test("a WABA with no deadline has no window to miss", () => {
    expect(historySyncWindowExpired(null, Date.now())).toBe(false);
    expect(historySyncWorthAttempting(null, Date.now())).toBe(true);
    expect(historySyncTimeRemainingMs(null, Date.now())).toBe(0);
  });

  test("retries stop before the deadline, not on it", () => {
    // The retry margin exists so the last stretch belongs to the operator: a
    // request fired at 23h59m has to reach Meta AND be accepted before the
    // window shuts, and there is nothing after it but offboarding.
    const lastRetryable = DEADLINE - HISTORY_SYNC_DEADLINE_MARGIN_MS - 1;
    expect(historySyncWorthAttempting(DEADLINE, lastRetryable)).toBe(true);
    expect(historySyncWorthAttempting(DEADLINE, DEADLINE - HISTORY_SYNC_DEADLINE_MARGIN_MS)).toBe(false);
    // And the window itself is still open there — the step gives up while there
    // is time left to act, which is the whole point.
    expect(historySyncWindowExpired(DEADLINE, DEADLINE - HISTORY_SYNC_DEADLINE_MARGIN_MS)).toBe(false);
  });

  test("time remaining counts down and floors at zero", () => {
    expect(historySyncTimeRemainingMs(DEADLINE, ONBOARDED_AT)).toBe(HISTORY_SYNC_WINDOW_MS);
    expect(historySyncTimeRemainingMs(DEADLINE, DEADLINE - 1_000)).toBe(1_000);
    expect(historySyncTimeRemainingMs(DEADLINE, DEADLINE + 60_000)).toBe(0);
  });

  test("the expiry error names the remedy, because Meta's remedy is offboarding", () => {
    const error = new HistorySyncWindowExpiredError(DEADLINE, true);
    expect(error.message).toBe(HISTORY_SYNC_EXPIRED_ERROR);
    expect(error.message).toContain("offboarding");
    expect(error.deadlineAt).toBe(DEADLINE);
    expect(error.closed).toBe(true);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("coexistence status derivation", () => {
  const NOTHING = {
    contactsStartedAt: null,
    contactsRequestId: null,
    historyStartedAt: null,
    historyRequestId: null,
  };
  const BOTH_ACCEPTED = {
    contactsStartedAt: ONBOARDED_AT + 400,
    contactsRequestId: "req-contacts",
    historyStartedAt: ONBOARDED_AT + 800,
    historyRequestId: "req-history",
  };
  const base = {
    onboardingType: "coexistence" as const,
    deadlineAt: DEADLINE,
    now: ONBOARDED_AT + 1_000,
  };

  test("a standard onboarding owes nothing, whatever the clock says", () => {
    expect(
      coexistenceSyncStatus({
        ...base,
        ...NOTHING,
        onboardingType: "standard",
        deadlineAt: null,
        now: DEADLINE + 10 * HISTORY_SYNC_WINDOW_MS,
      }),
    ).toBe("not_applicable");
    expect(coexistenceSyncOutstanding({ onboardingType: "standard", ...NOTHING })).toBe(false);
    expect(coexistenceSyncSpentUnconfirmed({ onboardingType: "standard", ...NOTHING })).toBe(false);
  });

  test("a fresh coexistence onboarding is pending", () => {
    expect(coexistenceSyncStatus({ ...base, ...NOTHING })).toBe("pending");
    expect(coexistenceSyncOutstanding({ onboardingType: "coexistence", ...NOTHING })).toBe(true);
  });

  test("contacts accepted alone is not done — Meta wants both", () => {
    const half = {
      ...NOTHING,
      contactsStartedAt: ONBOARDED_AT + 400,
      contactsRequestId: "req-contacts",
    };
    expect(coexistenceSyncStatus({ ...base, ...half })).toBe("pending");
    expect(coexistenceSyncOutstanding({ onboardingType: "coexistence", ...half })).toBe(true);
    expect(coexistenceSyncSpentUnconfirmed({ onboardingType: "coexistence", ...half })).toBe(false);
  });

  test("both accepted is initiated, and stays so long after the deadline", () => {
    expect(coexistenceSyncStatus({ ...base, ...BOTH_ACCEPTED })).toBe("initiated");
    // The deadline is about *initiating* the sync. Having done it in time is
    // permanent; the clock running out afterwards changes nothing.
    expect(coexistenceSyncStatus({ ...base, ...BOTH_ACCEPTED, now: DEADLINE + 60_000 })).toBe(
      "initiated",
    );
    expect(coexistenceSyncOutstanding({ onboardingType: "coexistence", ...BOTH_ACCEPTED })).toBe(
      false,
    );
  });

  test("an unmet obligation past the deadline reads as expired, with no write needed", () => {
    // Derived from the clock on every read: a WABA whose window closed at 02:00
    // reads expired at 03:00 even though nothing has run since.
    expect(coexistenceSyncStatus({ ...base, ...NOTHING, now: DEADLINE + 1 })).toBe("expired");
  });
});

/**
 * Meta allows each sync exactly once per phone number (`2593107`), so "we sent
 * it and never heard back" is a terminal state, not a retry. These are the
 * predicates that keep the saga from ever making the second call.
 */
describe("once-only semantics", () => {
  const base = {
    onboardingType: "coexistence" as const,
    deadlineAt: DEADLINE,
    now: ONBOARDED_AT + 1_000,
  };
  const ISSUED_UNANSWERED = {
    contactsStartedAt: ONBOARDED_AT + 400,
    contactsRequestId: null,
    historyStartedAt: null,
    historyRequestId: null,
  };

  test("an issued-but-unconfirmed sync is unconfirmed, not pending", () => {
    expect(coexistenceSyncStatus({ ...base, ...ISSUED_UNANSWERED })).toBe("unconfirmed");
    expect(
      coexistenceSyncSpentUnconfirmed({ onboardingType: "coexistence", ...ISSUED_UNANSWERED }),
    ).toBe(true);
  });

  test("a started sync is never outstanding again, so it can never be re-issued", () => {
    // This is the whole safety property: `startedAt` is written before the
    // request goes out, and its mere presence retires that sync forever.
    expect(
      coexistenceSyncOutstanding({ onboardingType: "coexistence", ...ISSUED_UNANSWERED }),
    ).toBe(true); // history is still untouched...
    expect(
      coexistenceSyncOutstanding({
        onboardingType: "coexistence",
        contactsStartedAt: ONBOARDED_AT + 400,
        contactsRequestId: null,
        historyStartedAt: ONBOARDED_AT + 600,
        historyRequestId: null,
      }),
    ).toBe(false); // ...but once both are started, nothing is left to send.
  });

  test("unconfirmed outranks expired: the once-only rule bites first", () => {
    // Both are terminal with the same remedy, but the operator should be told
    // what actually happened, and a spent sync is the more specific fact.
    expect(
      coexistenceSyncStatus({ ...base, ...ISSUED_UNANSWERED, now: DEADLINE + 1 }),
    ).toBe("unconfirmed");
  });

  test("the unconfirmed error explains why there is no retry", () => {
    const error = new SyncUnconfirmedError();
    expect(error.message).toBe(SYNC_UNCONFIRMED_ERROR);
    expect(error.message).toContain("once");
    expect(error.message).toContain("offboard");
    expect(error).toBeInstanceOf(Error);
  });
});

/**
 * The evidence half of the onboarding type (eccos-vss, item 3).
 *
 * `/connect` asks Meta for a WhatsApp Business app onboarding by putting
 * `featureType` in `extras` on the OAuth dialog URL — and `extras` is documented
 * only as an `FB.login()` option. Observed on 2026-09-01: the dialog ignores it
 * and runs the ordinary Cloud API flow, so the requested type proves nothing.
 * These are the rules that decide what the once-only sync is allowed to believe.
 */
describe("onboarding verification from Meta's own answer", () => {
  test("both of Meta's conditions together mean coexistence", () => {
    // Verbatim from "Check onboarding status": if `is_on_biz_app` is true and
    // `platform_type` is `CLOUD_API`, the number can use both.
    expect(COEXISTENCE_PLATFORM_TYPE).toBe("CLOUD_API");
    expect(
      verifiedOnboardingTypeFrom({ isOnBizApp: true, platformType: "CLOUD_API" }),
    ).toBe("coexistence");
  });

  test("a number that is not on the business app is a standard onboarding", () => {
    expect(
      verifiedOnboardingTypeFrom({ isOnBizApp: false, platformType: "CLOUD_API" }),
    ).toBe("standard");
  });

  test("the platform must be Cloud API, not merely present", () => {
    expect(verifiedOnboardingTypeFrom({ isOnBizApp: true, platformType: "NOT_APPLICABLE" })).toBe(
      "standard",
    );
    expect(verifiedOnboardingTypeFrom({ isOnBizApp: true, platformType: "ON_PREMISE" })).toBe(
      "standard",
    );
  });

  /**
   * The asymmetry that protects the customer. The only thing this answer gates
   * is a call Meta allows once per number and whose remedy for a wrong one is
   * offboarding, so a field Meta did not send can never be read as consent.
   */
  test("a field Meta did not send is not evidence, and never authorises the sync", () => {
    expect(verifiedOnboardingTypeFrom({ isOnBizApp: null, platformType: "CLOUD_API" })).toBe(
      "standard",
    );
    expect(verifiedOnboardingTypeFrom({ isOnBizApp: true, platformType: null })).toBe("standard");
    expect(verifiedOnboardingTypeFrom({ isOnBizApp: null, platformType: null })).toBe("standard");
  });
});

describe("a verified non-coexistence number owes nothing", () => {
  const NOTHING = {
    contactsStartedAt: null,
    contactsRequestId: null,
    historyStartedAt: null,
    historyRequestId: null,
  };
  const requested = {
    onboardingType: "coexistence" as const,
    verifiedOnboardingType: "standard" as const,
    ...NOTHING,
  };

  test("Meta's verdict overrides what /connect asked for", () => {
    expect(coexistenceSyncStatus({ ...requested, deadlineAt: DEADLINE, now: ONBOARDED_AT })).toBe(
      "not_coexistence",
    );
    // And nothing may be issued for it, on this attempt or any later one.
    expect(coexistenceSyncOutstanding(requested)).toBe(false);
  });

  /**
   * The reason this check sits before the deadline check. A WABA that owes no
   * sync must never age into `expired` — that message tells an operator to
   * offboard a customer, and here there is nothing to offboard over.
   */
  test("it never ages into an expired window", () => {
    expect(
      coexistenceSyncStatus({
        ...requested,
        deadlineAt: DEADLINE,
        now: DEADLINE + 10 * HISTORY_SYNC_WINDOW_MS,
      }),
    ).toBe("not_coexistence");
  });

  test("an unverified coexistence WABA is still pending, not assumed either way", () => {
    expect(
      coexistenceSyncStatus({
        onboardingType: "coexistence",
        verifiedOnboardingType: null,
        ...NOTHING,
        deadlineAt: DEADLINE,
        now: ONBOARDED_AT,
      }),
    ).toBe("pending");
    expect(
      coexistenceSyncOutstanding({
        onboardingType: "coexistence",
        verifiedOnboardingType: null,
        ...NOTHING,
      }),
    ).toBe(true);
  });

  /**
   * A sync that actually went through outranks a later verdict: the calls were
   * made and confirmed, and no amount of re-reading can un-make them.
   */
  test("a completed sync stays initiated even if the verdict says standard", () => {
    expect(
      coexistenceSyncStatus({
        onboardingType: "coexistence",
        verifiedOnboardingType: "standard",
        contactsStartedAt: ONBOARDED_AT + 400,
        contactsRequestId: "req-contacts",
        historyStartedAt: ONBOARDED_AT + 800,
        historyRequestId: "req-history",
        deadlineAt: DEADLINE,
        now: ONBOARDED_AT + 1_000,
      }),
    ).toBe("initiated");
  });
});

describe("onboarding type validation", () => {
  test("only the two known types are accepted", () => {
    expect(isWabaOnboardingType("standard")).toBe(true);
    expect(isWabaOnboardingType("coexistence")).toBe(true);
    for (const value of ["", "COEXISTENCE", "whatsapp_business_app_onboarding", null, undefined, 1]) {
      expect(isWabaOnboardingType(value)).toBe(false);
    }
  });
});
