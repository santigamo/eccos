import { graphBaseUrl, type CoreConfig } from "@eccos/core/config-schema";

type MetaAppConfig = Pick<CoreConfig, "META_GRAPH_VERSION" | "META_APP_SECRET" | "META_APP_ID">;
type MetaGraphConfig = Pick<CoreConfig, "META_GRAPH_VERSION">;
type MetaSubscriptionConfig = Pick<CoreConfig, "META_GRAPH_VERSION" | "META_WEBHOOK_VERIFY_TOKEN">;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export class MetaGraphError extends Error {
  readonly status: number;

  constructor(operation: string, status: number, message: string | null) {
    super(`${operation} failed: ${status}${message ? `: ${message}` : ""}`);
    this.name = "MetaGraphError";
    this.status = status;
  }
}

function graphError(prefix: string, res: Response, json: unknown): MetaGraphError {
  const error = asRecord(asRecord(json)?.error);
  const message = typeof error?.message === "string" ? error.message : null;
  return new MetaGraphError(prefix, res.status, message);
}

/** code -> Business Integration System User access token (60 days). */
export async function exchangeCodeForToken(
  cfg: MetaAppConfig,
  code: string,
  redirectUri?: string,
): Promise<string> {
  const query = [
    `client_id=${encodeURIComponent(cfg.META_APP_ID ?? "")}`,
    `client_secret=${encodeURIComponent(cfg.META_APP_SECRET)}`,
    `code=${encodeURIComponent(code)}`,
  ];
  if (redirectUri) query.push(`redirect_uri=${encodeURIComponent(redirectUri)}`);
  const url = `${graphBaseUrl(cfg)}/oauth/access_token?${query.join("&")}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !json?.access_token) throw graphError("exchange", res, json);
  return json.access_token;
}

export interface PhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
}

const MAX_PHONE_NUMBER_PAGES = 100;

/** GET /<waba_id>/phone_numbers with the business token. */
export async function listPhoneNumbers(
  cfg: MetaGraphConfig,
  wabaId: string,
  token: string,
): Promise<PhoneNumber[]> {
  const graphOrigin = new URL(graphBaseUrl(cfg)).origin;
  let nextUrl: string | null = `${graphBaseUrl(cfg)}/${encodeURIComponent(wabaId)}/phone_numbers`;
  const seenUrls = new Set<string>();
  const phones: PhoneNumber[] = [];

  for (let page = 0; page < MAX_PHONE_NUMBER_PAGES && nextUrl; page++) {
    if (seenUrls.has(nextUrl)) throw new Error("phone_numbers pagination repeated a page");
    seenUrls.add(nextUrl);
    const res = await fetch(nextUrl, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: unknown;
      paging?: { next?: unknown };
    } | null;
    if (!res.ok) throw graphError("phone_numbers", res, json);
    if (Array.isArray(json?.data)) {
      for (const value of json.data) {
        const record = asRecord(value);
        if (typeof record?.id !== "string" || record.id.trim() === "") continue;
        phones.push({
          id: record.id,
          ...(typeof record.display_phone_number === "string"
            ? { display_phone_number: record.display_phone_number }
            : {}),
          ...(typeof record.verified_name === "string" ? { verified_name: record.verified_name } : {}),
        });
      }
    }
    const rawNext = typeof json?.paging?.next === "string" ? json.paging.next : null;
    if (!rawNext) {
      nextUrl = null;
      break;
    }
    const parsedNext: URL = new URL(rawNext, nextUrl);
    if (parsedNext.origin !== graphOrigin) throw new Error("phone_numbers pagination returned an unexpected host");
    parsedNext.searchParams.delete("access_token");
    nextUrl = parsedNext.href;
  }

  if (nextUrl !== null && seenUrls.size >= MAX_PHONE_NUMBER_PAGES) {
    throw new Error("phone_numbers pagination exceeded the page limit");
  }
  return phones;
}

/**
 * What Meta says a business phone number actually is — the authoritative answer
 * to "was this really a WhatsApp Business app (coexistence) onboarding?".
 *
 * Source, verbatim from "Onboard WhatsApp Business app users" → *Check
 * onboarding status* (read 2026-09-01):
 *
 *     curl 'https://graph.facebook.com/v25.0/106540352242922?fields=is_on_biz_app,platform_type' \
 *     -H 'Authorization: Bearer EAAJB...'
 *
 *     {"is_on_biz_app": true, "platform_type": "CLOUD_API", "id": "106540352242922"}
 *
 * Meta labels the step "(optional)". It is not optional for Eccos: it is the
 * only thing standing between an assumption made at `/connect` and the
 * once-only `smb_app_data` sync that assumption authorises. A field Meta does
 * not return comes back as `null` rather than `false`, because the caller's
 * policy distinguishes "Meta says no" from "Meta did not say" — see
 * `verifiedOnboardingTypeFrom` in `src/coexistence.ts`.
 *
 * Throws `MetaGraphError` on a non-2xx. The caller must treat a throw as "not
 * known yet" and try again later; it must never treat it as a verdict.
 */
export interface PhoneNumberOnboarding {
  isOnBizApp: boolean | null;
  platformType: string | null;
}

export async function getPhoneNumberOnboarding(
  cfg: MetaGraphConfig,
  phoneNumberId: string,
  token: string,
): Promise<PhoneNumberOnboarding> {
  const url = `${graphBaseUrl(cfg)}/${encodeURIComponent(phoneNumberId)}?fields=is_on_biz_app%2Cplatform_type`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw graphError("phone_number onboarding", res, json);
  const record = asRecord(json);
  return {
    isOnBizApp: typeof record?.is_on_biz_app === "boolean" ? record.is_on_biz_app : null,
    platformType: typeof record?.platform_type === "string" ? record.platform_type : null,
  };
}

export function extractTokenTargetIds(payload: unknown): string[] {
  const data = asRecord(asRecord(payload)?.data);
  const granularScopes = Array.isArray(data?.granular_scopes) ? data.granular_scopes : [];
  const targetIds = new Set<string>();

  for (const granularScope of granularScopes) {
    const scope = asRecord(granularScope);
    if (!scope) continue;
    const name = scope?.scope;
    if (name !== "whatsapp_business_management" && name !== "whatsapp_business_messaging") continue;
    const ids = Array.isArray(scope.target_ids) ? scope.target_ids : [];
    for (const id of ids) {
      if (typeof id === "string" && id.trim() !== "") targetIds.add(id);
    }
  }

  return [...targetIds];
}

async function listTokenTargetIds(cfg: MetaAppConfig, token: string): Promise<string[]> {
  if (!cfg.META_APP_ID) throw new Error("META_APP_ID is required to inspect Embedded Signup token");
  const appAccessToken = `${cfg.META_APP_ID}|${cfg.META_APP_SECRET}`;
  const url =
    `${graphBaseUrl(cfg)}/debug_token` +
    `?input_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${appAccessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw graphError("debug_token", res, json);
  return extractTokenTargetIds(json);
}

export async function findWabaPhoneNumbers(
  cfg: MetaAppConfig,
  token: string,
): Promise<{ wabaId: string; phones: PhoneNumber[] } | null> {
  const matches = await findWabaPhoneNumbersForToken(cfg, token);
  return matches[0] ?? null;
}

export async function findWabaPhoneNumbersForToken(
  cfg: MetaAppConfig,
  token: string,
): Promise<Array<{ wabaId: string; phones: PhoneNumber[] }>> {
  const targetIds = await listTokenTargetIds(cfg, token);
  const matches: Array<{ wabaId: string; phones: PhoneNumber[] }> = [];
  let firstError: unknown;
  for (const targetId of targetIds) {
    try {
      const phones = await listPhoneNumbers(cfg, targetId, token);
      if (phones.length > 0) matches.push({ wabaId: targetId, phones });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return matches;
}

/** POST /<waba_id>/subscribed_apps pointing the callback at this Worker. */
export async function subscribeApp(
  cfg: MetaSubscriptionConfig,
  wabaId: string,
  token: string,
  callbackUrl: string,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("override_callback_uri", callbackUrl);
  body.set("verify_token", cfg.META_WEBHOOK_VERIFY_TOKEN);
  const res = await fetch(`${graphBaseUrl(cfg)}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw graphError("subscribed_apps", res, json);
}
