import { findTemplate } from "@eccos/core/templates";
import type { MetaAppConfig } from "@eccos/core/config-schema";
import type { CreateBroadcastResult } from "@eccos/gateway-contract";
import type { BroadcastRequest } from "./broadcasts";
import type { EccosGateway } from "./gateway";

type Refusal = Extract<CreateBroadcastResult, { ok: false }>;

/** A refusal, plus Meta's own error when the template lookup failed (the HTTP route returns it as is). */
export type BroadcastStart = Exclude<CreateBroadcastResult, Refusal> | (Refusal & { upstream?: unknown });

const STATUS_FIELDS = ["name", "language", "status"];

/**
 * The one path from a parsed broadcast to a queued one, shared by
 * `POST /v1/wabas/:wabaId/broadcasts` and the console's `createBroadcast`:
 * replay by idempotency key, the template check (APPROVED in exactly that
 * language), the caller's build against that template, then the queue.
 *
 * A replay is answered before the template is read, so a retry gets the
 * broadcast it created even if the template changed since.
 */
export async function startBroadcast(opts: {
  stub: DurableObjectStub<EccosGateway>;
  cfg: MetaAppConfig;
  accountId: string;
  phoneNumberId: string;
  ratePerMinute: number;
  templateName: string;
  language: string;
  key?: string;
  bodyHash: string;
  /** Extra template fields `build` reads, beyond name, language and status. */
  templateFields?: readonly string[];
  build: (template: Record<string, unknown>) => { ok: true; request: BroadcastRequest; duplicates: number } | Refusal;
}): Promise<BroadcastStart> {
  const { stub, key, bodyHash, accountId } = opts;
  if (key !== undefined) {
    const replay = await stub.replayBroadcast(accountId, key, bodyHash);
    if (replay.state === "existing" && replay.broadcast) return { ok: true, broadcast: replay.broadcast, replayed: true };
    if (replay.state === "reused") return { ok: false, code: "key_reused", detail: null };
  }

  // Checked once here rather than failing every recipient at Meta.
  const found = await findTemplate(opts.cfg, opts.templateName, opts.language, [
    ...STATUS_FIELDS,
    ...(opts.templateFields ?? []),
  ]);
  if (!found.ok) {
    const detail = typeof found.error === "string" ? found.error : JSON.stringify(found.error ?? null);
    return { ok: false, code: "templates_unreachable", detail, upstream: found.error };
  }
  if (!found.template) return { ok: false, code: "template_not_found", detail: null };
  const status = String(found.template.status ?? "");
  if (status !== "APPROVED") return { ok: false, code: "template_not_approved", detail: null, templateStatus: status };

  const built = opts.build(found.template);
  if (!built.ok) return built;
  const created = await stub.createBroadcast({
    accountId,
    phoneNumberId: opts.phoneNumberId,
    request: built.request,
    duplicates: built.duplicates,
    ratePerMinute: opts.ratePerMinute,
    ...(key !== undefined ? { idempotencyKey: key } : {}),
    bodyHash,
  });
  if (created.state === "reused") return { ok: false, code: "key_reused", detail: null };
  if (created.state === "busy" || !created.broadcast) {
    return { ok: false, code: "too_many_running", detail: null };
  }
  return { ok: true, broadcast: created.broadcast, replayed: created.state === "existing" };
}
