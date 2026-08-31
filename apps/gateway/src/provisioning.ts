import { getGatewayStubForWaba } from "./gateway-stub";
import {
  MetaGraphError,
  subscribeApp,
} from "./meta/connect-api";
import { getAppConfig } from "./tenant-config";
import { getControlPlaneStub } from "./control-plane-stub";
import type {
  AccountWaba,
  ProvisioningFailure,
  WabaProvisioningClaim,
} from "./control-plane";
import type { ProvisioningStatus } from "@eccos/gateway-contract";

type ProvisioningStage = "configuration" | "meta" | "gateway";

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

function failureFor(stage: ProvisioningStage, error: unknown): ProvisioningFailure {
  if (stage === "meta") return metaFailure(error);
  if (stage === "configuration") return { kind: "configuration", retryable: false };
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
  return "WABA provisioning failed";
}

export async function runClaim(
  env: Env,
  claim: WabaProvisioningClaim,
): Promise<ProvisioningRun> {
  const controlPlane = getControlPlaneStub(env);
  let stage: ProvisioningStage = "configuration";
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
    const waba = await controlPlane.completeWabaProvisioning({
      accountId: claim.accountId,
      wabaId: claim.wabaId,
      revision: claim.revision,
      attempt: claim.attempt,
      success: true,
    });
    return { waba, attempted: true, error: null };
  } catch (error) {
    const failure = failureFor(stage, error);
    const waba = await controlPlane.completeWabaProvisioning({
      accountId: claim.accountId,
      wabaId: claim.wabaId,
      revision: claim.revision,
      attempt: claim.attempt,
      success: false,
      failure,
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
