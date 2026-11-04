import { graphBaseUrl } from "@eccos/core/config-schema";
import type { inspectToken } from "./connect-api";

type Cfg = Parameters<typeof inspectToken>[0];

const PHONE_FIELDS = [
  "display_phone_number", "verified_name", "status", "is_on_biz_app", "platform_type",
  "code_verification_status", "name_status", "account_mode", "quality_rating",
  "messaging_limit_tier", "throughput", "health_status", "last_onboarded_time",
];
const WABA_FIELDS = [
  "name", "currency", "timezone_id", "account_review_status", "business_verification_status",
  "country", "ownership_type", "primary_funding_id", "on_behalf_of_business_info",
  "owner_business_info", "health_status",
];
const DEBUG_TOKEN_FIELDS = [
  "app_id", "type", "application", "is_valid", "expires_at", "data_access_expires_at",
  "scopes", "granular_scopes",
];

type Read = { value: unknown } | { status: number; code: unknown; subcode: unknown; message: unknown };

/** Graph GET reduced to its answer or its error. `paging` is dropped: its URLs can carry tokens. */
async function read(cfg: Cfg, path: string, auth: string): Promise<Read> {
  const res = await fetch(`${graphBaseUrl(cfg)}/${path}`, {
    headers: { authorization: `Bearer ${auth}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const error = json?.error as { code?: unknown; error_subcode?: unknown; message?: unknown } | undefined;
    return { status: res.status, code: error?.code, subcode: error?.error_subcode, message: error?.message };
  }
  const { paging: _paging, ...value } = json ?? {};
  return { value };
}

/** One request per field, so a field Meta rejects cannot hide the others. */
async function readFields(cfg: Cfg, node: string, fields: string[], token: string) {
  const entries = await Promise.all(
    fields.map(async (field) => {
      const answer = await read(cfg, `${node}?fields=${field}`, token);
      return [field, "value" in answer ? (answer.value as Record<string, unknown>)[field] ?? null : answer];
    }),
  );
  return Object.fromEntries(entries);
}

/** Read-only view of what Meta reports for a WABA, for diagnosing an onboarding. Never returns the token. */
export async function diagnoseWaba(cfg: Cfg, wabaId: string, phoneNumberId: string | null, token: string) {
  const debug = await read(
    cfg,
    `debug_token?input_token=${encodeURIComponent(token)}`,
    `${cfg.META_APP_ID}|${cfg.META_APP_SECRET}`,
  );
  const data = "value" in debug ? (debug.value as { data?: Record<string, unknown> }).data ?? {} : null;
  return {
    token: data
      ? Object.fromEntries(DEBUG_TOKEN_FIELDS.map((field) => [field, data[field] ?? null]))
      : debug,
    waba: await readFields(cfg, wabaId, WABA_FIELDS, token),
    subscribedApps: await read(cfg, `${wabaId}/subscribed_apps`, token),
    phone: phoneNumberId ? await readFields(cfg, phoneNumberId, PHONE_FIELDS, token) : null,
  };
}
