import { getGatewayStubForWaba } from "./gateway-stub";
import {
  MetaGraphError,
  subscribeApp,
} from "./meta/connect-api";
import { initiateContactsSync, initiateHistorySync } from "./meta/smb-app-data";
import {
  HISTORY_SYNC_EXPIRED_ERROR,
  SYNC_UNCONFIRMED_ERROR,
  HistorySyncWindowExpiredError,
  SyncUnconfirmedError,
  coexistenceSyncOutstanding,
  coexistenceSyncSpentUnconfirmed,
  historySyncWorthAttempting,
  historySyncWindowExpired,
} from "./coexistence";
import { getAppConfig } from "./tenant-config";
import { getControlPlaneStub } from "./control-plane-stub";
import type {
  AccountWaba,
  CoexistenceSyncProgress,
  ProvisioningFailure,
  WabaProvisioningClaim,
} from "./control-plane";
import type { ProvisioningStatus } from "@eccos/gateway-contract";

type ProvisioningStage = "configuration" | "meta" | "gateway" | "coexistence";

/**
 * Stand-in request id for a sync Meta accepted without returning one. Meta's
 * documented success body carries `request_id`, but acceptance is the 2xx, so a
 * missing id must not read as "issued and never answered" — which is terminal.
 */
const SYNC_ACCEPTED_WITHOUT_REQUEST_ID = "accepted";

export interface ProvisioningRun {
  waba: AccountWaba | null;
  attempted: boolean;
  error: string | null;
}

function metaFailure(error: unknown): ProvisioningFailure {
  const status = error instanceof MetaGraphError ? error.status : undefined;
  const retryable =
    status === undefined ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500;
  return {
    kind: "meta",
    ...(status === undefined ? {} : { status }),
    retryable,
  };
}

/**
 * Classify a coexistence failure — and note that, unlike every other stage,
 * almost nothing here is retryable (eccos-vss).
 *
 * Meta allows each sync exactly once per phone number; a duplicate is error
 * `2593107` whose remedy is offboarding the customer. A 5xx or a timeout does
 * not prove Meta failed to process the request, so "retry the sync" is not a
 * safe operation *at all* once the request has left. The saga therefore does not
 * back off into a second attempt: it fails terminally and tells the operator the
 * one thing that does work, which is to offboard and onboard again.
 *
 * The single retryable case is a failure that happened *before* any request was
 * issued — a stale claim, a missing config — where nothing has been spent and
 * the next attempt starts from exactly the same place.
 */
function coexistenceFailure(error: unknown, issued: boolean): ProvisioningFailure {
  if (error instanceof HistorySyncWindowExpiredError) {
    return { kind: "coexistence_expired", retryable: false };
  }
  if (error instanceof SyncUnconfirmedError) {
    return { kind: "coexistence_unconfirmed", retryable: false };
  }
  if (!issued) return { kind: "coexistence", retryable: true };
  const status = error instanceof MetaGraphError ? error.status : undefined;
  return {
    kind: "coexistence_unconfirmed",
    ...(status === undefined ? {} : { status }),
    retryable: false,
  };
}

function failureFor(
  stage: ProvisioningStage,
  error: unknown,
  syncIssued: boolean,
): ProvisioningFailure {
  if (stage === "meta") return metaFailure(error);
  if (stage === "configuration") return { kind: "configuration", retryable: false };
  if (stage === "coexistence") return coexistenceFailure(error, syncIssued);
  return { kind: "gateway", retryable: true };
}

function failureText(failure: ProvisioningFailure): string {
  if (failure.kind === "meta") {
    return failure.status === undefined
      ? "subscribed_apps request failed"
      : `subscribed_apps failed with HTTP ${failure.status}`;
  }
  if (failure.kind === "gateway") return "gateway configuration sync failed";
  if (failure.kind === "configuration") return "Meta subscription configuration is invalid";
  if (failure.kind === "coexistence_expired") return HISTORY_SYNC_EXPIRED_ERROR;
  if (failure.kind === "coexistence_unconfirmed") return SYNC_UNCONFIRMED_ERROR;
  if (failure.kind === "coexistence") return "coexistence sync could not be started";
  return "WABA provisioning failed";
}

/**
 * The coexistence step of the saga (eccos-vss).
 *
 * After a WhatsApp Business app onboarding, Meta requires a Tech Provider to
 * initiate contacts synchronisation and — within 24 hours — message-history
 * synchronisation, and prescribes offboarding the customer if that window
 * closes. So this is a saga step, not a fire-and-forget call: it runs under the
 * same lease and revision guard as `subscribed_apps`, and a WABA that has not
 * had it done stays visibly unfinished instead of reading as fully provisioned.
 *
 * Ordering matters. It runs *after* `subscribed_apps` and after the per-WABA
 * Durable Object has its config: the history Meta sends back arrives as
 * `history` webhooks, so asking for it before the subscription and the data
 * plane are in place would spill the answer on the floor.
 *
 * The once-only rule shapes the rest. Each sync is durably marked *before* its
 * request goes out, so a lost response can never become a duplicate call, and
 * `progress` carries back only the acceptances Meta confirmed — contacts getting
 * through and history not is recorded, and neither is ever sent twice.
 *
 * Nothing here stores a contact. The calls ask Meta to start synchronising;
 * what comes back is somebody else's problem, and by design not a table.
 */
async function runCoexistenceSync(
  env: Env,
  claim: WabaProvisioningClaim,
  progress: CoexistenceSyncProgress,
  /** Flipped the instant a sync is durably spent, so the caller knows whether a
   * failure is still safe to retry. */
  spend: { issued: boolean },
): Promise<void> {
  const { coexistence } = claim;
  if (coexistence.onboardingType !== "coexistence") return;

  // A sync that was issued and never confirmed is spent: Meta allows exactly one
  // per phone number, and no answer proves it was not processed. Retrying a lost
  // 200 is precisely how a working onboarding gets broken, so the step refuses
  // rather than gambles, and the operator gets the remedy Meta prescribes.
  if (coexistenceSyncSpentUnconfirmed(coexistence)) throw new SyncUnconfirmedError();
  if (!coexistenceSyncOutstanding(coexistence)) return;

  const deadlineAt = coexistence.deadlineAt;
  const now = Date.now();
  // Check the clock before touching the network. Past the window Meta answers
  // `2593108` and the one allowed call is burned for nothing; inside the margin
  // there is not enough left for an attempt to be worth its only shot.
  if (historySyncWindowExpired(deadlineAt, now) || !historySyncWorthAttempting(deadlineAt, now)) {
    throw new HistorySyncWindowExpiredError(
      deadlineAt ?? now,
      historySyncWindowExpired(deadlineAt, now),
    );
  }

  const appConfig = getAppConfig(env);
  // Coexistence is a property of the number that stays on the WhatsApp Business
  // app, so every phone the onboarding registered is synchronised, not just the
  // primary one the data plane is configured with.
  const phoneNumberIds = claim.phones.map((phone) => phone.phoneNumberId);
  if (phoneNumberIds.length === 0) throw new Error("incomplete provisioning record");
  const controlPlane = getControlPlaneStub(env);

  // Contacts first, then history: Meta documents them in that order, and history
  // is the one on the clock, so it goes last and closest to its deadline check.
  const steps = [
    {
      kind: "contacts" as const,
      startedAt: coexistence.contactsStartedAt,
      initiate: initiateContactsSync,
      record: (requestId: string | null) => {
        progress.contactsRequestId = requestId;
      },
    },
    {
      kind: "history" as const,
      startedAt: coexistence.historyStartedAt,
      initiate: initiateHistorySync,
      record: (requestId: string | null) => {
        progress.historyRequestId = requestId;
      },
    },
  ];

  for (const step of steps) {
    if (step.startedAt !== null) continue;
    // Durably spend the one allowed call BEFORE issuing it. If this write loses
    // its guard the claim is stale and someone else owns the WABA; making the
    // call anyway could duplicate theirs.
    const started = await controlPlane.beginCoexistenceSync({
      accountId: claim.accountId,
      wabaId: claim.wabaId,
      revision: claim.revision,
      attempt: claim.attempt,
      syncKind: step.kind,
      at: Date.now(),
    });
    if (!started) throw new Error(`coexistence ${step.kind} sync could not be claimed`);
    // Past this line the one allowed call is gone whatever happens next.
    spend.issued = true;
    let requestId: string | null = null;
    for (const phoneNumberId of phoneNumberIds) {
      const accepted = await step.initiate(appConfig, phoneNumberId, claim.metaAccessToken);
      requestId ??= accepted.requestId;
    }
    // Meta documents no request id for some responses; acceptance is the 2xx.
    // A placeholder keeps "confirmed" distinguishable from "issued, unanswered".
    step.record(requestId ?? SYNC_ACCEPTED_WITHOUT_REQUEST_ID);
  }
}

export async function runClaim(
  env: Env,
  claim: WabaProvisioningClaim,
): Promise<ProvisioningRun> {
  const controlPlane = getControlPlaneStub(env);
  let stage: ProvisioningStage = "configuration";
  // Carried out of the try/catch so a failed attempt still records whatever the
  // coexistence step managed to initiate before it broke.
  const coexistence: CoexistenceSyncProgress = {
    contactsRequestId: claim.coexistence.contactsRequestId,
    historyRequestId: claim.coexistence.historyRequestId,
    error: null,
  };
  const spend = { issued: false };
  try {
    const appConfig = getAppConfig(env);
    const primaryPhone = claim.phones[0];
    if (!claim.callbackUrl || !primaryPhone) throw new Error("incomplete provisioning record");
    stage = "meta";
    await subscribeApp(appConfig, claim.wabaId, claim.metaAccessToken, claim.callbackUrl);
    stage = "gateway";
    await getGatewayStubForWaba(env, claim.wabaId).saveConfig({
      META_WABA_ID: claim.wabaId,
      META_PHONE_NUMBER_ID: primaryPhone.phoneNumberId,
      DISPLAY_PHONE_NUMBER: primaryPhone.displayPhoneNumber,
      META_WEBHOOK_CALLBACK_URL: claim.callbackUrl,
      CONNECTED_AT: String(Date.now()),
    });
    stage = "coexistence";
    await runCoexistenceSync(env, claim, coexistence, spend);
    const waba = await controlPlane.completeWabaProvisioning({
      accountId: claim.accountId,
      wabaId: claim.wabaId,
      revision: claim.revision,
      attempt: claim.attempt,
      success: true,
      coexistence,
    });
    return { waba, attempted: true, error: null };
  } catch (error) {
    const failure = failureFor(stage, error, spend.issued);
    coexistence.error = stage === "coexistence" ? failureText(failure) : null;
    const waba = await controlPlane.completeWabaProvisioning({
      accountId: claim.accountId,
      wabaId: claim.wabaId,
      revision: claim.revision,
      attempt: claim.attempt,
      success: false,
      failure,
      coexistence,
    });
    return { waba, attempted: true, error: failureText(failure) };
  }
}

export async function provisionWaba(
  env: Env,
  accountId: string,
  wabaId: string,
): Promise<ProvisioningRun> {
  const controlPlane = getControlPlaneStub(env);
  const claim = await controlPlane.claimWabaProvisioning(accountId, wabaId);
  if (!claim) {
    const waba = await controlPlane.getWabaRecord(accountId, wabaId);
    return {
      waba,
      attempted: false,
      error: waba?.provisioningError ?? null,
    };
  }
  return runClaim(env, claim);
}

export async function reconcileWaba(
  env: Env,
  accountId: string,
  wabaId: string,
): Promise<ProvisioningRun> {
  const controlPlane = getControlPlaneStub(env);
  let waba = await controlPlane.getWabaRecord(accountId, wabaId);
  if (!waba) return { waba: null, attempted: false, error: null };
  if (waba.status === "failed") {
    waba = await controlPlane.retryWabaProvisioning(accountId, wabaId);
  }
  if (!waba) return { waba: null, attempted: false, error: null };
  return provisionWaba(env, accountId, wabaId);
}

export async function resubscribeWaba(
  env: Env,
  accountId: string,
  wabaId: string,
): Promise<ProvisioningRun> {
  const controlPlane = getControlPlaneStub(env);
  const waba = await controlPlane.getWaba(accountId, wabaId);
  if (!waba) {
    const record = await controlPlane.getWabaRecord(accountId, wabaId);
    return {
      waba: record,
      attempted: false,
      error: record?.provisioningError ?? `WABA "${wabaId}" is not active`,
    };
  }
  const primaryPhone = waba.phones[0];
  if (!waba.callbackUrl) {
    return { waba, attempted: false, error: "META_WEBHOOK_CALLBACK_URL is not configured" };
  }
  if (!primaryPhone) {
    return { waba, attempted: false, error: "WABA has no registered phone numbers" };
  }
  try {
    const appConfig = getAppConfig(env);
    await subscribeApp(appConfig, waba.wabaId, waba.metaAccessToken, waba.callbackUrl);
    await getGatewayStubForWaba(env, waba.wabaId).saveConfig({
      META_WABA_ID: waba.wabaId,
      META_PHONE_NUMBER_ID: primaryPhone.phoneNumberId,
      DISPLAY_PHONE_NUMBER: primaryPhone.displayPhoneNumber,
      META_WEBHOOK_CALLBACK_URL: waba.callbackUrl,
    });
    return { waba, attempted: true, error: null };
  } catch (error) {
    return {
      waba,
      attempted: true,
      error: error instanceof MetaGraphError
        ? `subscribed_apps failed with HTTP ${error.status}`
        : "WABA resubscription failed",
    };
  }
}

export async function reconcilePendingWabas(env: Env, limit = 20): Promise<void> {
  const controlPlane = getControlPlaneStub(env);
  try {
    await controlPlane.purgeExpiredConnectStates(Date.now());
  } catch {}
  const claims = await controlPlane.claimPendingWabaProvisioning(limit);
  for (const claim of claims) {
    await runClaim(env, claim);
  }
}

/**
 * Provisioning kicked off for a set of freshly registered WABAs (eccos-lpk).
 *
 * `statuses` is filled as each WABA settles, so a caller that gives up waiting
 * still gets whatever finished inside its budget; `done` resolves when every
 * kick has settled and never rejects.
 */
export interface ProvisioningKick {
  readonly statuses: Map<string, ProvisioningStatus>;
  readonly done: Promise<void>;
}

/**
 * Kick the targeted reconciler for each WABA the connect callback just
 * registered, instead of leaving them `pending` until the next five-minute cron
 * run (eccos-lpk). Nothing here is a shortcut around the saga: it goes through the
 * same `reconcileWaba` → `claimWabaProvisioning` lease + revision guard the cron
 * uses, so a concurrent cron run either loses the claim or wins it, and never
 * provisions twice. A kick that throws is swallowed: the row stays `pending`
 * with its backoff intact for the cron to retry, and the operator's redirect is
 * never held hostage to Meta.
 */
export function kickWabaProvisioning(
  env: Env,
  accountId: string,
  wabaIds: readonly string[],
): ProvisioningKick {
  const statuses = new Map<string, ProvisioningStatus>();
  const done = (async () => {
    for (const wabaId of wabaIds) {
      try {
        const run = await reconcileWaba(env, accountId, wabaId);
        if (run.waba) statuses.set(wabaId, run.waba.status);
      } catch {
        // Left for the cron: the control plane still holds a pending row.
      }
    }
  })();
  return { statuses, done };
}
