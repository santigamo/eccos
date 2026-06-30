import { graphBaseUrl, type CoreConfig } from "./config-schema";

export type TemplatesResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: unknown };

/** List approved/pending message templates for the configured WABA. */
export async function listTemplates(cfg: CoreConfig, limit = 100): Promise<TemplatesResult> {
  const url = `${graphBaseUrl(cfg)}/${cfg.META_WABA_ID}/message_templates?limit=${limit}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.META_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, error: json };
  return { ok: true, data: json };
}
