import { graphBaseUrl, type CoreConfig } from "@eccos/core/config-schema";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function graphError(prefix: string, res: Response, json: unknown): Error {
  const error = asRecord(asRecord(json)?.error);
  const message = typeof error?.message === "string" ? error.message : null;
  return new Error(`${prefix} failed: ${res.status}${message ? `: ${message}` : ""}`);
}

/** code -> Business Integration System User access token (60 days). */
export async function exchangeCodeForToken(
  cfg: CoreConfig,
  code: string,
  redirectUri?: string,
): Promise<string> {
  const url =
    `${graphBaseUrl(cfg)}/oauth/access_token` +
    `?client_id=${encodeURIComponent(cfg.META_APP_ID ?? "")}` +
    `&client_secret=${encodeURIComponent(cfg.META_APP_SECRET)}` +
    `&code=${encodeURIComponent(code)}` +
    (redirectUri ? `&redirect_uri=${encodeURIComponent(redirectUri)}` : "");
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

/** GET /<waba_id>/phone_numbers with the business token. */
export async function listPhoneNumbers(
  cfg: CoreConfig,
  wabaId: string,
  token: string,
): Promise<PhoneNumber[]> {
  const url = `${graphBaseUrl(cfg)}/${wabaId}/phone_numbers?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => null)) as { data?: PhoneNumber[] } | null;
  if (!res.ok) throw graphError("phone_numbers", res, json);
  return json?.data ?? [];
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

async function listTokenTargetIds(cfg: CoreConfig, token: string): Promise<string[]> {
  if (!cfg.META_APP_ID) throw new Error("META_APP_ID is required to inspect Embedded Signup token");
  const appAccessToken = `${cfg.META_APP_ID}|${cfg.META_APP_SECRET}`;
  const url =
    `${graphBaseUrl(cfg)}/debug_token` +
    `?input_token=${encodeURIComponent(token)}` +
    `&access_token=${encodeURIComponent(appAccessToken)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw graphError("debug_token", res, json);
  return extractTokenTargetIds(json);
}

export async function findWabaPhoneNumbers(
  cfg: CoreConfig,
  token: string,
): Promise<{ wabaId: string; phones: PhoneNumber[] } | null> {
  const targetIds = await listTokenTargetIds(cfg, token);
  for (const targetId of targetIds) {
    try {
      const phones = await listPhoneNumbers(cfg, targetId, token);
      if (phones.length > 0) return { wabaId: targetId, phones };
    } catch {
      // debug_token may include non-WABA target IDs. Try the next candidate.
    }
  }
  return null;
}

/** POST /<waba_id>/subscribed_apps pointing the callback at this Worker. */
export async function subscribeApp(
  cfg: CoreConfig,
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
