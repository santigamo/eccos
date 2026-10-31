import { isBsuid } from "./bsuid";
import { graphBaseUrl, type MetaAppConfig } from "./config-schema";

export type SendResult =
  /** `waId` is the number Meta resolved the recipient to (the BSUID for a BSUID send); null if the response omits it. */
  | { ok: true; id: string; waId: string | null }
  | { ok: false; status: number; error: unknown };

/**
 * Send a message through the Meta Cloud API. `body` is the caller-supplied Meta
 * message object (everything except `messaging_product`, which we inject), e.g.
 * `{ to, type: "template", template: {...} }`. A `to` that is a BSUID is sent as
 * Meta's `recipient`, the field Meta addresses a business-scoped user id by.
 */
export async function sendMessage(
  cfg: MetaAppConfig,
  body: Record<string, unknown>,
): Promise<SendResult> {
  const phoneNumberId = cfg.META_PHONE_NUMBER_ID;
  if (!phoneNumberId) {
    return { ok: false, status: 0, error: "META_PHONE_NUMBER_ID is not configured" };
  }
  const url = `${graphBaseUrl(cfg)}/${phoneNumberId}/messages`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.META_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...addressed(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }

  const json = (await res.json().catch(() => null)) as
    | { contacts?: Array<{ wa_id?: string; user_id?: string }>; messages?: Array<{ id?: string }> }
    | null;

  if (!res.ok) return { ok: false, status: res.status, error: json };

  const id = json?.messages?.[0]?.id;
  if (!id) return { ok: false, status: res.status, error: json };

  const contact = json?.contacts?.[0];
  return { ok: true, id, waId: contact?.wa_id ?? contact?.user_id ?? null };
}

function addressed(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.to !== "string" || !isBsuid(body.to)) return body;
  const { to, ...rest } = body;
  return { ...rest, recipient: to };
}
