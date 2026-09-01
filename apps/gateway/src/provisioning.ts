import { getGatewayStubForWaba } from "./gateway-stub";
import {
  MetaGraphError,
  getPhoneNumberOnboarding,
  listPhoneNumbers,
  subscribeApp,
} from "./meta/connect-api";
import { initiateContactsSync, initiateHistorySync } from "./meta/smb-app-data";
import {
  HISTORY_SYNC_EXPIRED_ERROR,
  NOT_COEXISTENCE_ERROR,
  SYNC_UNCONFIRMED_ERROR,
  HistorySyncWindowExpiredError,
  SyncUnconfirmedError,
  coexistenceSyncOutstanding,
  coexistenceSyncSpentUnconfirmed,
  historySyncWorthAttempting,
  historySyncWindowExpired,
  verifiedOnboardingTypeFrom,
} from "./coexistence";
import { getAppConfig } from "./tenant-config";
import { getControlPlaneStub } from "./control-plane-stub";
import { AWAITING_PHONE_NUMBER_ERROR } from "./provisioning-messages";
import type { WabaOnboardingType } from "./coexistence";
import type {
  AccountWaba,
  CoexistenceSyncProgress,
  PhoneRecord,
  ProvisioningFailure,
  WabaProvisioningClaim,
} from "./control-plane";
import type { ProvisioningStatus } from "@eccos/gateway-contract";

type ProvisioningStage = "configuration" | "meta" | "gateway" | "coexistence";

/**
 * Raised when a WABA is connected and subscribed but has no business phone
 * number to configure yet (Embedded Signup v4).
 *
 * v2 always handed back a verified number, so "no phone" could only mean a
 * broken record and the saga treated it as one. v4 lets a customer finish the
 * flow with a verified number, an unverified number, or none at all, so this is
 * now an ordinary outcome of a successful onboarding — retryable, and described
 * in terms of what is missing rather than as a configuration fault.
 */
class AwaitingPhoneNumberError extends Error {
  constructor() {
    super(AWAITING_PHONE_NUMBER_ERROR);
    this.name = "AwaitingPhoneNumberError";
  }
}

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
  // Not a stage failure at all: the WABA is connected and subscribed, it just
  // has no number yet. Checked first so it cannot be mistaken for whichever
  // stage happened to be running.
  if (error instanceof AwaitingPhoneNumberError) {
    return { kind: "awaiting_phone_number", retryable: true };
  }
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
  if (failure.kind === "awaiting_phone_number") return AWAITING_PHONE_NUMBER_ERROR;
  if (failure.kind === "coexistence_expired") return HISTORY_SYNC_EXPIRED_ERROR;
  if (failure.kind === "coexistence_unconfirmed") return SYNC_UNCONFIRMED_ERROR;
  if (failure.kind === "coexistence") return "coexistence sync could not be started";
  return "WABA provisioning failed";
}

/**
 * Pick up a business phone number that appeared on the WABA after the handoff.
 *
 * The v4 flow can complete with none, so `claim.phones` being empty is a normal
 * state rather than a broken record, and the number the customer eventually adds
 * is invisible to Eccos until something asks. Each provisioning attempt asks
 * once; the ordinary retry schedule does the waiting.
 *
 * Anything that goes wrong here is swallowed on purpose. Failing to *find* a
 * number must produce the same honest "no number yet" outcome as there genuinely
 * not being one — a Graph hiccup should not be reported to an operator as a Meta
 * subscription failure on a WABA that subscribed perfectly well.
 */
async function adoptPhonesFromMeta(
  env: Env,
  cfg: Parameters<typeof listPhoneNumbers>[0],
  claim: WabaProvisioningClaim,
): Promise<PhoneRecord[]> {
  try {
    const discovered = await listPhoneNumbers(cfg, claim.wabaId, claim.metaAccessToken);
    if (discovered.length === 0) return [];
    return await getControlPlaneStub(env).adoptWabaPhones({
      accountId: claim.accountId,
      wabaId: claim.wabaId,
      revision: claim.revision,
      attempt: claim.attempt,
      phones: discovered.map((phone) => ({
        phoneNumberId: phone.id,
        displayPhoneNumber: phone.display_phone_number ?? "",
      })),
    });
  } catch {
    return [];
  }
}

/**
 * Read back from Meta what the onboarding actually produced, for every number
 * the handoff registered (eccos-vss, item 3).
 *
 * Every phone must verify as coexistence for the WABA to count as one. The
 * once-only state Eccos keeps is per WABA while Meta's rule is per phone
 * number, so a mixed WABA cannot be represented — and of the two ways to
 * collapse it, "all or nothing" is the one whose mistake is recoverable: it
 * declines a sync that was owed, rather than issuing one that was not.
 *
 * Short-circuits on the first `standard`: the answer cannot change, and there is
 * no reason to spend more Graph calls confirming it.
 */
async function verifyOnboardingType(
  cfg: Parameters<typeof getPhoneNumberOnboarding>[0],
  phoneNumberIds: readonly string[],
  token: string,
): Promise<WabaOnboardingType> {
  for (const phoneNumberId of phoneNumberIds) {
    const evidence = await getPhoneNumberOnboarding(cfg, phoneNumberId, token);
    if (verifiedOnboardingTypeFrom(evidence) !== "coexistence") return "standard";
  }
  return "coexistence";
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
 * And nothing is issued on trust. `/connect` records the onboarding it *asked*
 * Meta for; this step first reads back the onboarding Meta actually performed
 * and issues only if the two agree. That check is not belt-and-braces, it is
 * load-bearing: the `extras.featureType` the dialog URL carries was observed on
 * 2026-09-01 to be ignored, so the requested type on its own is not evidence of
 * anything.
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

  const appConfig = getAppConfig(env);
  // Coexistence is a property of the number that stays on the WhatsApp Business
  // app, so every phone the onboarding registered is synchronised, not just the
  // primary one the data plane is configured with.
  const phoneNumberIds = claim.phones.map((phone) => phone.phoneNumberId);
  if (phoneNumberIds.length === 0) throw new Error("incomplete provisioning record");

  // ── Evidence, before anything irreversible ────────────────────────────────
  // Ask Meta what it actually did, and believe that rather than what `/connect`
  // asked for. This runs *before* the deadline check on purpose: a number that
  // is not coexistent owes no sync, so it must not be able to fail with an
  // expired-window error and send an operator off to offboard a working
  // customer over an obligation that never existed.
  //
  // A throw here is a failure to *learn* the answer, not an answer. It happens
  // before `spend.issued` is ever set, so the saga classifies it retryable and
  // the next attempt asks again — with the 24-hour window still running, which
  // is the correct pressure: an unanswerable verification eventually expires
  // rather than silently authorising the call it was meant to gate.
  const verified =
    coexistence.verifiedOnboardingType ??
    (await verifyOnboardingType(appConfig, phoneNumberIds, claim.metaAccessToken));
  progress.verifiedOnboardingType = verified;
  if (verified !== "coexistence") {
    // Terminal, and deliberately not an error: the WABA provisions successfully
    // because the number genuinely works. What it does not do is quietly keep
    // claiming an obligation it never had.
    progress.error = NOT_COEXISTENCE_ERROR;
    return;
  }

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
    verifiedOnboardingType: claim.coexistence.verifiedOnboardingType,
    error: null,
  };
  const spend = { issued: false };
  try {
    const appConfig = getAppConfig(env);
    if (!claim.callbackUrl) throw new Error("incomplete provisioning record");
    // Subscribing is a WABA-level call and needs no phone number, so it happens
    // before the number is known to exist. That ordering is what makes a
    // number-less v4 onboarding recoverable rather than inert: the webhooks are
    // already flowing when the customer finally adds one.
    stage = "meta";
    await subscribeApp(appConfig, claim.wabaId, claim.metaAccessToken, claim.callbackUrl);

    // Embedded Signup v4 can finish with no business phone number at all. When
    // the handoff produced none, ask Meta again — the customer may have added
    // one since — and adopt whatever has appeared.
    const phones =
      claim.phones.length > 0
        ? claim.phones
        : await adoptPhonesFromMeta(env, appConfig, claim);
    const primaryPhone = phones[0];
    // Still nothing to send from. Not a fault, and not `active`: there is no
    // data plane to configure and no sync that could apply to a number that
    // does not exist.
    if (!primaryPhone) throw new AwaitingPhoneNumberError();

    stage = "gateway";
    await getGatewayStubForWaba(env, claim.wabaId).saveConfig({
      META_WABA_ID: claim.wabaId,
      META_PHONE_NUMBER_ID: primaryPhone.phoneNumberId,
      DISPLAY_PHONE_NUMBER: primaryPhone.displayPhoneNumber,
      META_WEBHOOK_CALLBACK_URL: claim.callbackUrl,
      CONNECTED_AT: String(Date.now()),
    });
    stage = "coexistence";
    await runCoexistenceSync(env, { ...claim, phones }, coexistence, spend);
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
