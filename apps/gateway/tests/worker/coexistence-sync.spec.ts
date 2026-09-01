import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { GatewayRPC } from "../../src/rpc";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { provisionWaba } from "../../src/provisioning";
import {
  HISTORY_SYNC_EXPIRED_ERROR,
  HISTORY_SYNC_DEADLINE_MARGIN_MS,
  HISTORY_SYNC_WINDOW_MS,
  NOT_COEXISTENCE_ERROR,
  SYNC_UNCONFIRMED_ERROR,
} from "../../src/coexistence";
import { SMB_APP_DATA_EDGE, SMB_APP_DATA_SYNC_TYPE } from "../../src/meta/smb-app-data";

/**
 * The coexistence step of the provisioning saga (eccos-vss).
 *
 * Meta requires a Tech Provider that onboards a WhatsApp Business app user to
 * initiate contacts synchronisation and — within 24 hours — message-history
 * synchronisation, and prescribes offboarding the customer if that window
 * closes. It also allows each sync **exactly once** per phone number: a second
 * call is error `2593107`, and its remedy is again offboarding. That once-only
 * rule is what shapes these tests — the interesting states are not "retrying"
 * but "spent", and the saga's job is to never make the second call.
 */

const CALLBACK_URL = "https://gateway.example/webhooks/meta";
const PHONES = [{ phoneNumberId: "PN_COEX_1", displayPhoneNumber: "+34 600 000 001" }];

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

async function createAccount(accountId: string): Promise<void> {
  await cp((instance) => instance.createAccount({ accountId }));
}

async function begin(
  accountId: string,
  wabaId: string,
  onboardingType: "standard" | "coexistence",
  phones = PHONES,
) {
  return cp((instance) =>
    instance.beginWabaProvisioning({
      accountId,
      wabaId,
      metaAccessToken: "token-coex",
      callbackUrl: CALLBACK_URL,
      onboardingType,
      phones,
    }),
  );
}

interface SyncCall {
  url: string;
  syncType: string;
}

function accepted(requestId = "REQ_1"): Response {
  return new Response(
    JSON.stringify({ messaging_product: "whatsapp", request_id: requestId }),
    { status: 200 },
  );
}

/** Meta's answer for a number that really is on the WhatsApp Business app. */
function verifiedCoexistence(): Response {
  return new Response(
    JSON.stringify({ id: "PN", is_on_biz_app: true, platform_type: "CLOUD_API" }),
    { status: 200 },
  );
}

/**
 * Routes the Graph mock by URL and records every sync request. Tests assert on
 * the resulting *state*; only the two shape-level assertions below look at the
 * body, so a correction to Meta's contract stays contained.
 *
 * `verifyResponse` answers the onboarding-verification read the saga makes
 * before it spends anything. It defaults to "yes, coexistence", which is the
 * precondition every sync test below is actually about; the tests that care
 * about the verification itself override it.
 */
function mockGraph(
  syncResponse: (call: SyncCall) => Response,
  verifyResponse: () => Response = verifiedCoexistence,
) {
  const syncCalls: SyncCall[] = [];
  const verifyCalls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/subscribed_apps")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes("is_on_biz_app")) {
        verifyCalls.push(url);
        return verifyResponse();
      }
      if (url.includes(SMB_APP_DATA_EDGE)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { sync_type?: string };
        const call: SyncCall = { url, syncType: body.sync_type ?? "" };
        syncCalls.push(call);
        return syncResponse(call);
      }
      throw new Error(`unexpected request to ${url}`);
    },
  );
  return { syncCalls, verifyCalls };
}

function row(instance: EccosControlPlane, wabaId: string): Record<string, unknown> {
  return instance.sql
    .exec(
      `SELECT status, provisioning_error, provisioning_attempts, onboarding_type,
              coexistence_verified_type,
              coexistence_sync_status, coexistence_sync_deadline_at, coexistence_sync_error,
              contacts_sync_started_at, contacts_sync_request_id,
              history_sync_started_at, history_sync_request_id
       FROM wabas WHERE waba_id = ?`,
      wabaId,
    )
    .toArray()[0] as Record<string, unknown>;
}

function forceDue(instance: EccosControlPlane, wabaId: string): void {
  instance.sql.exec(
    "UPDATE wabas SET provisioning_next_attempt_at = ?, provisioning_lease_until = NULL WHERE waba_id = ?",
    Date.now(),
    wabaId,
  );
}

/** Move the WABA's 24-hour window so the deadline sits at `deadlineAt`. */
function setDeadline(instance: EccosControlPlane, wabaId: string, deadlineAt: number): void {
  instance.sql.exec(
    "UPDATE wabas SET coexistence_sync_deadline_at = ? WHERE waba_id = ?",
    deadlineAt,
    wabaId,
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("coexistence synchronisation as a saga step", () => {
  it("initiates both syncs on a fresh coexistence onboarding", async () => {
    const accountId = "acc-coex-fresh";
    const wabaId = "WABA_COEX_FRESH";
    await createAccount(accountId);
    const { syncCalls } = mockGraph((call) =>
      accepted(call.syncType === SMB_APP_DATA_SYNC_TYPE.history ? "REQ_HIST" : "REQ_CONT"),
    );

    const before = Date.now();
    const queued = await begin(accountId, wabaId, "coexistence");
    expect(queued.waba.status).toBe("pending");
    // The clock starts at the handoff, not at the first attempt.
    expect(queued.waba.coexistence).toMatchObject({
      onboardingType: "coexistence",
      status: "pending",
      contactsStartedAt: null,
      historyStartedAt: null,
    });
    expect(queued.waba.coexistence.deadlineAt).toBeGreaterThanOrEqual(
      before + HISTORY_SYNC_WINDOW_MS,
    );

    await provisionWaba(env, accountId, wabaId);

    // Contacts first, then history — Meta documents them in that order, and
    // history is the one on the clock.
    expect(syncCalls.map((call) => call.syncType)).toEqual([
      SMB_APP_DATA_SYNC_TYPE.contacts,
      SMB_APP_DATA_SYNC_TYPE.history,
    ]);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("active");
      expect(waba?.provisioningError).toBeNull();
      expect(waba?.coexistence.status).toBe("initiated");
      expect(waba?.coexistence.contactsStartedAt).toEqual(expect.any(Number));
      expect(waba?.coexistence.historyStartedAt).toEqual(expect.any(Number));
      // Meta's support references are kept, as the guide asks.
      expect(waba?.coexistence.contactsRequestId).toBe("REQ_CONT");
      expect(waba?.coexistence.historyRequestId).toBe("REQ_HIST");
      expect(waba?.coexistence.error).toBeNull();
    });
  });

  it("synchronises every number the onboarding registered, not just the primary", async () => {
    const accountId = "acc-coex-multi";
    const wabaId = "WABA_COEX_MULTI";
    await createAccount(accountId);
    const { syncCalls } = mockGraph(() => accepted());

    await begin(accountId, wabaId, "coexistence", [
      { phoneNumberId: "PN_COEX_A", displayPhoneNumber: "+34 600 000 010" },
      { phoneNumberId: "PN_COEX_B", displayPhoneNumber: "+34 600 000 011" },
    ]);
    await provisionWaba(env, accountId, wabaId);

    // Coexistence is a property of each number that stays on the WhatsApp
    // Business app: two numbers, two syncs each.
    expect(syncCalls).toHaveLength(4);
    for (const phoneNumberId of ["PN_COEX_A", "PN_COEX_B"]) {
      expect(syncCalls.filter((call) => call.url.includes(phoneNumberId))).toHaveLength(2);
    }
  });

  // --- Not for an ordinary onboarding ---------------------------------------
  it("does not run for a non-coexistence onboarding", async () => {
    const accountId = "acc-coex-standard";
    const wabaId = "WABA_COEX_STANDARD";
    await createAccount(accountId);
    const { syncCalls } = mockGraph(() => accepted());

    await begin(accountId, wabaId, "standard");
    await provisionWaba(env, accountId, wabaId);

    // Not one request, and no clock started: an ordinary Cloud API number owes
    // Meta nothing here, and must never be failed by a window it never had.
    expect(syncCalls).toHaveLength(0);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("active");
      expect(waba?.coexistence).toMatchObject({
        onboardingType: "standard",
        status: "not_applicable",
        deadlineAt: null,
        contactsStartedAt: null,
        historyStartedAt: null,
      });
    });
  });

  it("registration defaults to standard, so an omitted type never invents an obligation", async () => {
    const accountId = "acc-coex-default";
    const wabaId = "WABA_COEX_DEFAULT";
    await createAccount(accountId);
    const { syncCalls } = mockGraph(() => accepted());

    await cp((instance) =>
      instance.beginWabaProvisioning({
        accountId,
        wabaId,
        metaAccessToken: "token-coex",
        callbackUrl: CALLBACK_URL,
        phones: PHONES,
      }),
    );
    await provisionWaba(env, accountId, wabaId);

    expect(syncCalls).toHaveLength(0);
    await cp((instance) => {
      expect(row(instance, wabaId)).toMatchObject({
        onboarding_type: "standard",
        coexistence_sync_status: "not_applicable",
        coexistence_sync_deadline_at: null,
      });
    });
  });

  // --- The once-only rule ---------------------------------------------------
  //
  // Meta: "You can only perform this step once. If you need to perform it again,
  // the customer must first offboard, then complete the Embedded Signup flow
  // again." A retry that turns out to be a duplicate is `2593107` and breaks the
  // onboarding for good, so a request that was issued and not confirmed is
  // terminal — the opposite of the usual saga backoff.
  it("never re-issues a sync after a failure, and fails terminally instead", async () => {
    const accountId = "acc-coex-once";
    const wabaId = "WABA_COEX_ONCE";
    await createAccount(accountId);
    const { syncCalls } = mockGraph(
      () => new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }),
    );

    await begin(accountId, wabaId, "coexistence");
    const deadlineAt = await cp(
      async (instance) => (await instance.getWabaRecord(accountId, wabaId))?.coexistence.deadlineAt,
    );

    await provisionWaba(env, accountId, wabaId);

    // A 503 does not prove Meta failed to process the request, so the sync is
    // spent. Terminal, not pending — and the WABA is emphatically not active.
    await cp((instance) => {
      const record = row(instance, wabaId);
      expect(record.status).toBe("failed");
      expect(record.provisioning_error).toBe(SYNC_UNCONFIRMED_ERROR);
      expect(record.coexistence_sync_status).toBe("unconfirmed");
      // The start was recorded BEFORE the request went out; no confirmation came.
      expect(record.contacts_sync_started_at).toEqual(expect.any(Number));
      expect(record.contacts_sync_request_id).toBeNull();
      // Retrying must not hand the customer more of Meta's 24 hours either.
      expect(record.coexistence_sync_deadline_at).toBe(deadlineAt);
    });
    expect(syncCalls).toHaveLength(1);

    // The operator's re-check requeues the row — and it still must not make the
    // second call, because the first one may well have landed.
    await cp((instance) => instance.retryWabaProvisioning(accountId, wabaId));
    await provisionWaba(env, accountId, wabaId);

    expect(syncCalls).toHaveLength(1);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("failed");
      expect(waba?.provisioningError).toBe(SYNC_UNCONFIRMED_ERROR);
      expect(waba?.provisioningError).toContain("offboard");
      expect(waba?.coexistence.deadlineAt).toBe(deadlineAt);
    });
  });

  it("keeps a confirmed contacts sync and does not repeat it when history fails", async () => {
    const accountId = "acc-coex-partial";
    const wabaId = "WABA_COEX_PARTIAL";
    await createAccount(accountId);
    const { syncCalls } = mockGraph((call) =>
      call.syncType === SMB_APP_DATA_SYNC_TYPE.history
        ? new Response(JSON.stringify({ error: { message: "nope" } }), { status: 503 })
        : accepted("REQ_CONT"),
    );

    await begin(accountId, wabaId, "coexistence");
    await provisionWaba(env, accountId, wabaId);

    await cp((instance) => {
      const record = row(instance, wabaId);
      // Contacts is confirmed and stays confirmed; history is spent unconfirmed.
      expect(record.contacts_sync_request_id).toBe("REQ_CONT");
      expect(record.history_sync_started_at).toEqual(expect.any(Number));
      expect(record.history_sync_request_id).toBeNull();
      expect(record.coexistence_sync_status).toBe("unconfirmed");
      expect(record.status).toBe("failed");
      forceDue(instance, wabaId);
    });

    // Re-running must not repeat contacts either — it was already accepted.
    await cp((instance) => instance.retryWabaProvisioning(accountId, wabaId));
    await provisionWaba(env, accountId, wabaId);
    expect(syncCalls.filter((c) => c.syncType === SMB_APP_DATA_SYNC_TYPE.contacts)).toHaveLength(1);
    expect(syncCalls.filter((c) => c.syncType === SMB_APP_DATA_SYNC_TYPE.history)).toHaveLength(1);
  });

  it("a failure before anything is issued stays retryable, with the deadline intact", async () => {
    const accountId = "acc-coex-preflight";
    const wabaId = "WABA_COEX_PREFLIGHT";
    await createAccount(accountId);
    // `subscribed_apps` fails, so the saga never reaches the sync step: nothing
    // has been spent, and this is the one shape of failure that may retry.
    let subscribeFails = true;
    const { syncCalls } = mockGraph(() => accepted());
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/subscribed_apps")) {
          return subscribeFails
            ? new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 })
            : new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (url.includes("is_on_biz_app")) return verifiedCoexistence();
        const body = JSON.parse(String(init?.body ?? "{}")) as { sync_type?: string };
        syncCalls.push({ url, syncType: body.sync_type ?? "" });
        return accepted();
      },
    );

    await begin(accountId, wabaId, "coexistence");
    const deadlineAt = await cp(
      async (instance) => (await instance.getWabaRecord(accountId, wabaId))?.coexistence.deadlineAt,
    );

    await provisionWaba(env, accountId, wabaId);

    await cp((instance) => {
      const record = row(instance, wabaId);
      expect(record.status).toBe("pending");
      expect(record.provisioning_error).toBe("subscribed_apps failed with HTTP 503");
      // Nothing issued, nothing spent, and the window untouched.
      expect(record.contacts_sync_started_at).toBeNull();
      expect(record.history_sync_started_at).toBeNull();
      expect(record.coexistence_sync_status).toBe("pending");
      expect(record.coexistence_sync_deadline_at).toBe(deadlineAt);
      forceDue(instance, wabaId);
    });
    expect(syncCalls).toHaveLength(0);

    subscribeFails = false;
    await provisionWaba(env, accountId, wabaId);

    expect(syncCalls).toHaveLength(2);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("active");
      expect(waba?.coexistence.status).toBe("initiated");
      expect(waba?.coexistence.deadlineAt).toBe(deadlineAt);
    });
  });

  // --- The deadline expiring is an explicit, operator-visible failure --------
  it("fails terminally with the offboarding remedy once the window has closed", async () => {
    const accountId = "acc-coex-expired";
    const wabaId = "WABA_COEX_EXPIRED";
    await createAccount(accountId);
    const { syncCalls } = mockGraph(() => accepted());

    await begin(accountId, wabaId, "coexistence");
    // The onboarding happened over 24 hours ago and nothing initiated the sync.
    await cp((instance) => setDeadline(instance, wabaId, Date.now() - 1_000));

    await provisionWaba(env, accountId, wabaId);

    // No request was made: past the window Meta answers `2593108`, and the one
    // allowed call would be burned for nothing.
    expect(syncCalls).toHaveLength(0);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      // Terminal, not pending: this never retries its way out, and the operator
      // is told the one thing they can do about it.
      expect(waba?.status).toBe("failed");
      expect(waba?.provisioningError).toBe(HISTORY_SYNC_EXPIRED_ERROR);
      expect(waba?.provisioningError).toContain("offboarding");
      expect(waba?.coexistence.status).toBe("expired");
      expect(waba?.coexistence.error).toBe(HISTORY_SYNC_EXPIRED_ERROR);
      // Nothing was spent, so a re-onboarding starts from a clean slate.
      expect(waba?.coexistence.contactsStartedAt).toBeNull();
    });
  });

  it("stops before the deadline, while the operator can still act", async () => {
    const accountId = "acc-coex-margin";
    const wabaId = "WABA_COEX_MARGIN";
    await createAccount(accountId);
    const { syncCalls } = mockGraph(() => accepted());

    await begin(accountId, wabaId, "coexistence");
    // Inside the retry margin: the window is technically still open, but not by
    // enough to spend the single allowed call on a race against the clock.
    await cp((instance) =>
      setDeadline(instance, wabaId, Date.now() + HISTORY_SYNC_DEADLINE_MARGIN_MS - 60_000),
    );

    await provisionWaba(env, accountId, wabaId);

    expect(syncCalls).toHaveLength(0);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("failed");
      expect(waba?.provisioningError).toBe(HISTORY_SYNC_EXPIRED_ERROR);
    });
  });

  it("an expired WABA reads as expired without anything having to run", async () => {
    const accountId = "acc-coex-derived";
    const wabaId = "WABA_COEX_DERIVED";
    await createAccount(accountId);
    await begin(accountId, wabaId, "coexistence");

    // Nothing provisions; only the clock moves past the deadline.
    await cp(async (instance) => {
      setDeadline(instance, wabaId, Date.now() - 1);
      const waba = await instance.getWabaRecord(accountId, wabaId);
      // The stored status still says "pending" — the derived one tells the truth,
      // so an operator listing WABAs sees the expiry without a job having run.
      expect(row(instance, wabaId).coexistence_sync_status).toBe("pending");
      expect(waba?.coexistence.status).toBe("expired");
    });
  });

  // --- Recovery -------------------------------------------------------------
  it("a genuinely new onboarding handoff gets a new window and a clean slate", async () => {
    const accountId = "acc-coex-reonboard";
    const wabaId = "WABA_COEX_REONBOARD";
    await createAccount(accountId);
    mockGraph(() => accepted());

    await begin(accountId, wabaId, "coexistence");
    await cp((instance) => setDeadline(instance, wabaId, Date.now() - 1_000));
    await provisionWaba(env, accountId, wabaId);
    await cp(async (instance) => {
      expect((await instance.getWabaRecord(accountId, wabaId))?.status).toBe("failed");
    });

    // The customer is offboarded and onboarded again: a fresh Embedded Signup
    // handoff, so Meta starts a fresh 24 hours and a fresh pair of one-shot
    // syncs. Without this an expired WABA could never be recovered.
    const after = Date.now();
    await begin(accountId, wabaId, "coexistence", [
      { phoneNumberId: "PN_COEX_1", displayPhoneNumber: "+34 600 000 002" },
    ]);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("pending");
      expect(waba?.coexistence.status).toBe("pending");
      expect(waba?.coexistence.deadlineAt).toBeGreaterThanOrEqual(after + HISTORY_SYNC_WINDOW_MS);
      expect(waba?.coexistence.contactsStartedAt).toBeNull();
      expect(waba?.coexistence.historyStartedAt).toBeNull();
    });

    await provisionWaba(env, accountId, wabaId);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("active");
      expect(waba?.coexistence.status).toBe("initiated");
    });
  });

  it("a stale claim cannot spend a sync", async () => {
    const accountId = "acc-coex-stale";
    const wabaId = "WABA_COEX_STALE";
    await createAccount(accountId);
    await begin(accountId, wabaId, "coexistence");

    await cp(async (instance) => {
      const claim = await instance.claimWabaProvisioning(accountId, wabaId);
      expect(claim).not.toBeNull();
      // The real claim can spend it once...
      expect(
        await instance.beginCoexistenceSync({
          accountId,
          wabaId,
          revision: claim!.revision,
          attempt: claim!.attempt,
          syncKind: "contacts",
          at: Date.now(),
        }),
      ).toBe(true);
      // ...and never twice, whatever the caller believes.
      expect(
        await instance.beginCoexistenceSync({
          accountId,
          wabaId,
          revision: claim!.revision,
          attempt: claim!.attempt,
          syncKind: "contacts",
          at: Date.now(),
        }),
      ).toBe(false);
      // A claim from another revision is rejected outright.
      expect(
        await instance.beginCoexistenceSync({
          accountId,
          wabaId,
          revision: claim!.revision + 1,
          attempt: claim!.attempt,
          syncKind: "history",
          at: Date.now(),
        }),
      ).toBe(false);
    });
  });

  it("never spends a sync for a standard onboarding, even if asked directly", async () => {
    const accountId = "acc-coex-guard";
    const wabaId = "WABA_COEX_GUARD";
    await createAccount(accountId);
    await begin(accountId, wabaId, "standard");

    await cp(async (instance) => {
      const claim = await instance.claimWabaProvisioning(accountId, wabaId);
      expect(
        await instance.beginCoexistenceSync({
          accountId,
          wabaId,
          revision: claim!.revision,
          attempt: claim!.attempt,
          syncKind: "history",
          at: Date.now(),
        }),
      ).toBe(false);
      expect(row(instance, wabaId).history_sync_started_at).toBeNull();
    });
  });
});

/**
 * The gate in front of the irreversible part (eccos-vss, item 3).
 *
 * `/connect` records `onboardingType: "coexistence"` because it asked Meta for
 * that flow through `extras.featureType` — which the OAuth dialog was observed
 * to ignore on 2026-09-01. So the request is not evidence, and the saga reads
 * back what Meta actually did before spending a call that Meta allows once and
 * whose remedy for a wrong one is offboarding the customer.
 */
describe("the coexistence sync is gated on Meta's own answer, not on what was requested", () => {
  /** Meta's answer for an ordinary Cloud API number. */
  function notCoexistence(): Response {
    return new Response(
      JSON.stringify({ id: "PN", is_on_biz_app: false, platform_type: "CLOUD_API" }),
      { status: 200 },
    );
  }

  it("issues nothing when Meta says the number is not a business app number", async () => {
    const accountId = "acc-coex-verify-no";
    const wabaId = "WABA_COEX_VERIFY_NO";
    await createAccount(accountId);
    const { syncCalls, verifyCalls } = mockGraph(() => accepted(), notCoexistence);

    await begin(accountId, wabaId, "coexistence");
    await provisionWaba(env, accountId, wabaId);

    // The whole point: the once-only calls were never made.
    expect(syncCalls).toHaveLength(0);
    expect(verifyCalls).toHaveLength(1);

    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      // Not a failure. The number works; it is simply not a coexistence number,
      // so it owes nothing and there is nothing for an operator to fix.
      expect(waba?.status).toBe("active");
      expect(waba?.provisioningError).toBeNull();
      expect(waba?.coexistence.status).toBe("not_coexistence");
      // What was asked for and what Meta did are both kept, and they disagree.
      expect(waba?.coexistence.onboardingType).toBe("coexistence");
      expect(waba?.coexistence.verifiedOnboardingType).toBe("standard");
      // And it says so in words an operator can act on.
      expect(waba?.coexistence.error).toBe(NOT_COEXISTENCE_ERROR);
      expect(waba?.coexistence.contactsStartedAt).toBeNull();
      expect(waba?.coexistence.historyStartedAt).toBeNull();
    });
  });

  it("does not let a WABA that owes nothing age into an expired window", async () => {
    const accountId = "acc-coex-verify-clock";
    const wabaId = "WABA_COEX_VERIFY_CLOCK";
    await createAccount(accountId);
    mockGraph(() => accepted(), notCoexistence);

    await begin(accountId, wabaId, "coexistence");
    await provisionWaba(env, accountId, wabaId);

    // Push the clock well past the 24-hour window. `expired` tells an operator
    // to offboard a customer; there is nothing here to offboard over.
    await cp(async (instance) => {
      setDeadline(instance, wabaId, Date.now() - HISTORY_SYNC_WINDOW_MS);
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.coexistence.status).toBe("not_coexistence");
      expect(waba?.status).toBe("active");
    });
  });

  it("treats an unanswerable verification as not-yet-known, and spends nothing", async () => {
    const accountId = "acc-coex-verify-down";
    const wabaId = "WABA_COEX_VERIFY_DOWN";
    await createAccount(accountId);
    let verifyFails = true;
    const { syncCalls } = mockGraph(
      () => accepted(),
      () =>
        verifyFails
          ? new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 })
          : verifiedCoexistence(),
    );

    await begin(accountId, wabaId, "coexistence");
    const deadlineAt = await cp(
      async (instance) => (await instance.getWabaRecord(accountId, wabaId))?.coexistence.deadlineAt,
    );

    await provisionWaba(env, accountId, wabaId);

    // A verification that could not be read is not a verdict: nothing is spent,
    // nothing is concluded, and the attempt stays retryable with the window
    // still running.
    expect(syncCalls).toHaveLength(0);
    await cp((instance) => {
      const record = row(instance, wabaId);
      expect(record.status).toBe("pending");
      expect(record.coexistence_verified_type).toBeNull();
      expect(record.coexistence_sync_status).toBe("pending");
      expect(record.coexistence_sync_deadline_at).toBe(deadlineAt);
      expect(record.contacts_sync_started_at).toBeNull();
      expect(record.history_sync_started_at).toBeNull();
      forceDue(instance, wabaId);
    });

    // Once Meta answers, the same claim proceeds exactly as it always did.
    verifyFails = false;
    await provisionWaba(env, accountId, wabaId);
    expect(syncCalls.map((call) => call.syncType)).toEqual([
      SMB_APP_DATA_SYNC_TYPE.contacts,
      SMB_APP_DATA_SYNC_TYPE.history,
    ]);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("active");
      expect(waba?.coexistence.status).toBe("initiated");
      expect(waba?.coexistence.verifiedOnboardingType).toBe("coexistence");
      expect(waba?.coexistence.deadlineAt).toBe(deadlineAt);
    });
  });

  it("asks Meta once per WABA and remembers the answer", async () => {
    const accountId = "acc-coex-verify-sticky";
    const wabaId = "WABA_COEX_VERIFY_STICKY";
    await createAccount(accountId);
    const { verifyCalls } = mockGraph(() => accepted(), notCoexistence);

    await begin(accountId, wabaId, "coexistence");
    await provisionWaba(env, accountId, wabaId);
    expect(verifyCalls).toHaveLength(1);

    // Force a genuine second provisioning attempt on the same registration —
    // the shape a cron re-run or a re-check takes — rather than relying on the
    // active row simply never being claimed again.
    await cp((instance) => {
      instance.sql.exec("UPDATE wabas SET status = 'pending' WHERE waba_id = ?", wabaId);
      forceDue(instance, wabaId);
    });
    await provisionWaba(env, accountId, wabaId);

    // The verdict is durable, so the attempt short-circuits without re-asking a
    // question Meta has already answered.
    expect(verifyCalls).toHaveLength(1);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("active");
      expect(waba?.coexistence.status).toBe("not_coexistence");
    });
  });

  /**
   * The once-only state Eccos keeps is per WABA while Meta's rule is per phone
   * number, so a WABA whose numbers disagree cannot be represented. Of the two
   * ways to collapse it, this is the recoverable one: decline a sync that was
   * owed rather than issue one that was not.
   */
  it("declines the whole WABA when any of its numbers is not a coexistence number", async () => {
    const accountId = "acc-coex-verify-mixed";
    const wabaId = "WABA_COEX_VERIFY_MIXED";
    await createAccount(accountId);
    let answered = 0;
    const { syncCalls } = mockGraph(
      () => accepted(),
      () => {
        answered += 1;
        return answered === 1 ? verifiedCoexistence() : notCoexistence();
      },
    );

    await begin(accountId, wabaId, "coexistence", [
      { phoneNumberId: "PN_MIXED_A", displayPhoneNumber: "+34 600 000 020" },
      { phoneNumberId: "PN_MIXED_B", displayPhoneNumber: "+34 600 000 021" },
    ]);
    await provisionWaba(env, accountId, wabaId);

    expect(syncCalls).toHaveLength(0);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("active");
      expect(waba?.coexistence.status).toBe("not_coexistence");
      expect(waba?.coexistence.verifiedOnboardingType).toBe("standard");
    });
  });

  it("never asks about a standard onboarding — there is nothing to gate", async () => {
    const accountId = "acc-coex-verify-standard";
    const wabaId = "WABA_COEX_VERIFY_STANDARD";
    await createAccount(accountId);
    const { syncCalls, verifyCalls } = mockGraph(() => accepted());

    await begin(accountId, wabaId, "standard");
    await provisionWaba(env, accountId, wabaId);

    expect(syncCalls).toHaveLength(0);
    expect(verifyCalls).toHaveLength(0);
    await cp(async (instance) => {
      const waba = await instance.getWabaRecord(accountId, wabaId);
      expect(waba?.status).toBe("active");
      expect(waba?.coexistence.status).toBe("not_applicable");
      expect(waba?.coexistence.verifiedOnboardingType).toBeNull();
    });
  });
});

/**
 * The projection the console actually reads.
 *
 * Every other test here inspects the WABA through `getWabaRecord`, and the
 * dashboard tests hand-build their resource objects — so both halves passed
 * while `listAccountResources` quietly omitted `coexistence_verified_type` from
 * its own hand-written column list. `coexistenceOf` then recomputed the status
 * from a `null` that was not really null, and the one surface an operator looks
 * at showed `expired` — the status whose documented remedy is offboarding the
 * customer — on a WABA that owed Meta nothing.
 *
 * These read through the real path (`GatewayRPC.listAccountResources`), which
 * is what the dashboard calls, rather than through the storage helper the rest
 * of this file uses.
 */
describe("the coexistence verdict survives the read the console makes", () => {
  function notCoexistence(): Response {
    return new Response(
      JSON.stringify({ id: "PN", is_on_biz_app: false, platform_type: "CLOUD_API" }),
      { status: 200 },
    );
  }

  async function resourceWaba(accountId: string, wabaId: string) {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const resources = await rpc.listAccountResources(accountId);
    return resources.wabas.find((waba) => waba.wabaId === wabaId);
  }

  it("reports not_coexistence, and keeps reporting it long past the deadline", async () => {
    const accountId = "acc-coex-projection";
    const wabaId = "WABA_COEX_PROJECTION";
    await createAccount(accountId);
    mockGraph(() => accepted(), notCoexistence);

    await begin(accountId, wabaId, "coexistence");
    await provisionWaba(env, accountId, wabaId);

    const fresh = await resourceWaba(accountId, wabaId);
    expect(fresh?.status).toBe("active");
    expect(fresh?.coexistence.verifiedOnboardingType).toBe("standard");
    expect(fresh?.coexistence.status).toBe("not_coexistence");

    // Past the 24-hour window. Without the verdict in the projection this reads
    // `expired`, and the console tells an operator to offboard a working
    // customer over a sync that was correctly never issued.
    await cp((instance) => setDeadline(instance, wabaId, Date.now() - HISTORY_SYNC_WINDOW_MS));
    const stale = await resourceWaba(accountId, wabaId);
    expect(stale?.coexistence.status).toBe("not_coexistence");
    expect(stale?.coexistence.status).not.toBe("expired");
  });

  it("carries the same coexistence fields as the per-WABA read", async () => {
    const accountId = "acc-coex-projection-parity";
    const wabaId = "WABA_COEX_PROJECTION_PARITY";
    await createAccount(accountId);
    mockGraph((call) =>
      accepted(call.syncType === SMB_APP_DATA_SYNC_TYPE.history ? "REQ_HIST" : "REQ_CONT"),
    );

    await begin(accountId, wabaId, "coexistence");
    await provisionWaba(env, accountId, wabaId);

    // Parity, not a spot check: the two reads must not be able to disagree
    // about coexistence, whichever column list they were written with.
    const direct = await cp((instance) => instance.getWabaRecord(accountId, wabaId));
    const listed = await resourceWaba(accountId, wabaId);
    expect(listed?.coexistence).toEqual(direct?.coexistence);
    expect(listed?.coexistence.status).toBe("initiated");
  });
});
