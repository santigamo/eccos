import { graphBaseUrl, type MetaAppConfig } from "./config-schema";

export type TemplatesResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: unknown };

/** List approved/pending message templates for the configured WABA. */
export async function listTemplates(cfg: MetaAppConfig, limit = 100): Promise<TemplatesResult> {
  const wabaId = cfg.META_WABA_ID;
  if (!wabaId) {
    return { ok: false, status: 0, error: "META_WABA_ID is not configured" };
  }
  const url = `${graphBaseUrl(cfg)}/${wabaId}/message_templates?limit=${limit}`;

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

/** One body-only text template, as the console authors it. Everything the
 * Graph request needs beyond the WABA id and its token. */
export interface CreateTemplateBody {
  name: string;
  language: string;
  category: string;
  bodyText: string;
  /** One example value per positional placeholder, in order. */
  examples?: string[];
}

/**
 * Create one message template on the configured WABA.
 *
 * The mirror image of {@link listTemplates}: same result shape, same 15s
 * timeout, same missing-WABA guard — and the same division of labour, in that
 * this reports what Meta said and never decides what it means. Validation lives
 * with the caller (CLAUDE.md: core stays free of HTTP/routing concerns).
 *
 * Two Meta facts are baked into the request shape:
 *  - `example.body_text` is an **array of arrays** (one inner array per example
 *    set). A flat array is accepted by the create call and then produces
 *    review-doomed templates, so the nesting is asserted in the tests.
 *  - No `allow_category_change`: Meta recategorises regardless — it is now the
 *    default behaviour — and the response's `category` is the one that counts.
 *  - No `parameter_format`: POSITIONAL is the default, and positional is the
 *    only shape this authors.
 */
export async function createTemplate(
  cfg: MetaAppConfig,
  input: CreateTemplateBody,
): Promise<TemplatesResult> {
  const wabaId = cfg.META_WABA_ID;
  if (!wabaId) {
    return { ok: false, status: 0, error: "META_WABA_ID is not configured" };
  }
  const examples = input.examples ?? [];
  const body = {
    name: input.name,
    language: input.language,
    category: input.category,
    components: [
      {
        type: "BODY",
        text: input.bodyText,
        // A zero-parameter body carries NO `example` key at all: an empty
        // example object is a shape Meta has no reason to accept.
        ...(examples.length > 0 ? { example: { body_text: [examples] } } : {}),
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch(`${graphBaseUrl(cfg)}/${wabaId}/message_templates`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.META_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, error: json };
  return { ok: true, data: json };
}

/**
 * Delete ONE translation of a template, by its Graph id (`hsm_id`).
 *
 * `name` travels alongside because Meta's per-translation form requires both.
 * The name-only form of this endpoint deletes **every language** of the
 * template, which is never what a row-level button should do — so this helper
 * has no way to express it.
 */
export async function deleteTemplate(
  cfg: MetaAppConfig,
  input: { name: string; hsmId: string },
): Promise<TemplatesResult> {
  const wabaId = cfg.META_WABA_ID;
  if (!wabaId) {
    return { ok: false, status: 0, error: "META_WABA_ID is not configured" };
  }
  const query = new URLSearchParams({ name: input.name, hsm_id: input.hsmId });

  let res: Response;
  try {
    res = await fetch(`${graphBaseUrl(cfg)}/${wabaId}/message_templates?${query}`, {
      method: "DELETE",
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
