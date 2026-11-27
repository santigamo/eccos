import { LANGUAGE_PATTERN, TEMPLATE_NAME_PATTERN } from "@eccos/core/template-rules";
import type { BroadcastPreflight, CreateBroadcastInput, CreateBroadcastResult } from "@eccos/gateway-contract";
import { broadcastBody } from "./broadcast-columns";
import { startBroadcast } from "./broadcast-start";
import {
  MAX_BROADCAST_BODY_BYTES,
  MAX_BROADCAST_RECIPIENTS,
  MAX_RUNNING_BROADCASTS,
  pacing,
  parseBroadcastRequest,
} from "./broadcasts";
import { SUBSCRIPTION_REQUIRED } from "./connect-policy";
import { getControlPlaneStub } from "./control-plane-stub";
import { isIdempotencyKey, sendBodyHash } from "./gateway";
import { getGatewayStubForWaba } from "./gateway-stub";
import { sendRatePerMinute } from "./send-rate-limit";
import { getAppConfig, tenantConfig } from "./tenant-config";

/** The pace a new broadcast would run at and how many already run on the WABA. */
export async function broadcastPreflight(env: Env, wabaId: string, accountId: string): Promise<BroadcastPreflight> {
  const { perTick, tickMs } = pacing(sendRatePerMinute(env, accountId));
  return {
    running: await getGatewayStubForWaba(env, wabaId).runningBroadcasts(),
    maxRunning: MAX_RUNNING_BROADCASTS,
    pacePerMinute: Math.round((perTick * 60_000) / tickMs),
    maxRecipients: MAX_BROADCAST_RECIPIENTS,
  };
}

/**
 * A console broadcast: the compact rows become the `POST /broadcasts` body
 * against the live template, then the same parse, replay, template check and
 * queue as the HTTP route. Fail-closed on a non-active WABA, like a send.
 */
export async function createConsoleBroadcast(
  env: Env,
  fetchFor: (wabaId: string) => typeof fetch,
  input: CreateBroadcastInput,
  accountId: string,
): Promise<CreateBroadcastResult> {
  if (JSON.stringify(input ?? null).length > MAX_BROADCAST_BODY_BYTES) {
    return { ok: false, code: "too_large", detail: null };
  }
  if (!isIdempotencyKey(input?.idempotencyKey)) throw new Error("invalid idempotencyKey");
  const waba = await getControlPlaneStub(env).getWabaForSend(accountId, input.wabaId);
  if (waba === SUBSCRIPTION_REQUIRED) return { ok: false, code: SUBSCRIPTION_REQUIRED, detail: null };
  if (!waba) throw new Error(`WABA "${input.wabaId}" is not owned by account "${accountId}"`);
  if (!waba.phones.some((phone) => phone.phoneNumberId === input.phoneNumberId)) {
    return { ok: false, code: "no_phone", detail: null };
  }
  if (!TEMPLATE_NAME_PATTERN.test(String(input.templateName)) || !LANGUAGE_PATTERN.test(String(input.languageCode))) {
    return { ok: false, code: "invalid_request", detail: "invalid template name or language" };
  }

  const { idempotencyKey, ...payload } = input;
  const started = await startBroadcast({
    stub: getGatewayStubForWaba(env, waba.wabaId),
    cfg: tenantConfig(getAppConfig(env), {
      wabaId: waba.wabaId,
      phoneNumberId: input.phoneNumberId,
      metaAccessToken: waba.metaAccessToken,
      fetch: fetchFor(waba.wabaId),
    }),
    accountId,
    phoneNumberId: input.phoneNumberId,
    ratePerMinute: sendRatePerMinute(env, accountId),
    templateName: input.templateName,
    language: input.languageCode,
    key: idempotencyKey,
    bodyHash: await sendBodyHash(input.phoneNumberId, payload),
    templateFields: ["category", "parameter_format", "components"],
    build: (template) => {
      const built = broadcastBody(input, template);
      if (!built.ok) return built;
      const parsed = parseBroadcastRequest(built.body);
      if (parsed.ok) return parsed;
      return parsed.invalid
        ? { ok: false, code: "invalid_recipients", detail: parsed.error, invalid: parsed.invalid }
        : { ok: false, code: "invalid_request", detail: parsed.error };
    },
  });
  console.log(
    JSON.stringify({
      level: "info",
      area: "rpc",
      event: "broadcast_create",
      wabaId: waba.wabaId,
      ...(started.ok ? { broadcastId: started.broadcast.id, replayed: started.replayed } : { code: started.code }),
    }),
  );
  if (started.ok) return started;
  const { upstream: _upstream, ...refusal } = started;
  return refusal;
}
