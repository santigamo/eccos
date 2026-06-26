import { graphBaseUrl, type CoreConfig } from "./config-schema";

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: unknown };

/**
 * Send a message through the Meta Cloud API. `body` is the caller-supplied Meta
 * message object (everything except `messaging_product`, which we inject), e.g.
 * `{ to, type: "template", template: {...} }`.
 */
export async function sendMessage(
  cfg: CoreConfig,
  body: Record<string, unknown>,
): Promise<SendResult> {
  const url = `${graphBaseUrl(cfg)}/${cfg.META_PHONE_NUMBER_ID}/messages`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.META_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }

  const json = (await res.json().catch(() => null)) as
    | { messages?: Array<{ id?: string }> }
    | null;

  if (!res.ok) return { ok: false, status: res.status, error: json };

  const id = json?.messages?.[0]?.id;
  if (!id) return { ok: false, status: res.status, error: json };

  return { ok: true, id };
}
