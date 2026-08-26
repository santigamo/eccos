import { Hono, type Context } from "hono";
import { getConfig, getEffectiveConfig } from "./config";
import { getGatewayStubForWaba } from "./gateway-stub";
import { connectRoutes } from "./routes/connect";
import { constantTimeEqual, verifyMetaSignature } from "@eccos/core/signature";
import {
  parseMetaEchoesBatches,
  parseMetaWebhookBatches,
  type MetaWebhookBatch,
} from "@eccos/core/parser";
import { sendMessage } from "@eccos/core/send";
import { listTemplates } from "@eccos/core/templates";

export { EccosGateway } from "./gateway";
export { GatewayRPC } from "./rpc";

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings }>();

app.route("/", connectRoutes());

function requestedWabaId(c: { req: { param(name: string): string } }): string {
  const wabaId = c.req.param("wabaId");
  if (!wabaId) throw new Error("WABA route is required");
  return wabaId;
}

function requestStub(c: { env: Bindings; req: { param(name: string): string } }) {
  const wabaId = requestedWabaId(c);
  return { wabaId, stub: getGatewayStubForWaba(c.env, wabaId) };
}

async function requestConfig(
  c: { env: Bindings },
  gateway: ReturnType<typeof getGatewayStubForWaba>,
  wabaId: string,
) {
  const config = await getEffectiveConfig(c.env, gateway);
  return wabaId && config.META_WABA_ID !== wabaId ? null : config;
}

function mergeBatches(batches: MetaWebhookBatch[]): MetaWebhookBatch[] {
  const merged = new Map<string, MetaWebhookBatch>();
  for (const batch of batches) {
    const key = `${batch.wabaId}\u0000${batch.phoneNumberId ?? ""}`;
    const existing = merged.get(key);
    if (existing) existing.events.push(...batch.events);
    else merged.set(key, { ...batch, events: [...batch.events] });
  }
  return [...merged.values()];
}

// --- Structured logging ------------------------------------------------------
//
// Minimal single-line JSON logs, one per notable route outcome, viewable via
// `wrangler tail` or the Cloudflare dashboard (Workers Logs / observability is
// already enabled in wrangler.jsonc). Every line carries a correlation id so a
// single request can be traced across log lines even without a log pipeline.
//
// SAFETY: `meta` may only carry ids, counts, booleans, and enum-like strings
// (event types, HTTP methods, key names). Never pass message bodies, full
// phone numbers, tokens, API keys, or signatures — see CLAUDE.md ("never log
// or write secrets").
type LogMeta = Record<string, string | number | boolean | null | undefined>;

/** `cf-ray` ties a log line back to the edge request Cloudflare already tracks;
 * falls back to a random id for local/dev requests where the header is absent. */
function correlationId(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("cf-ray") ?? crypto.randomUUID();
}

function logEvent(event: string, cid: string, status: number, meta: LogMeta = {}): void {
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  console.log(
    JSON.stringify({ time: new Date().toISOString(), level, event, correlationId: cid, status, ...meta }),
  );
}

app.onError((error, c) => {
  const path = new URL(c.req.url).pathname;
  const webhook = path === "/webhooks/meta";
  logEvent("unhandled_error", correlationId(c), webhook ? 200 : 500, {
    path,
    errorType: error instanceof Error ? error.name : "unknown",
  });
  if (webhook) return c.json({ ok: true, received: 0 }, 200);
  return c.json({ ok: false, error: "internal error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true, name: "eccos", version: "0.1.0" }));

// --- Readiness ----------------------------------------------------------------
//
// `/health` above is a pure liveness check: no I/O, always 200 while the
// Worker process is alive, safe for tight LB/uptime polling. `/ready`
// additionally confirms the gateway can actually serve traffic:
//   - the Durable Object responds to a cheap RPC call, and
//   - the required Meta/API secrets are present (booleans + key names only —
//     never values).
// Returns 200 when both checks pass, 503 otherwise.

/** Keep in sync with the required (non-optional, no-default) fields of
 * packages/core/src/config-schema.ts#coreSchema. */
const REQUIRED_CONFIG_KEYS = [
  "META_ACCESS_TOKEN",
  "META_PHONE_NUMBER_ID",
  "META_WABA_ID",
  "META_APP_SECRET",
  "META_WEBHOOK_VERIFY_TOKEN",
  "ECCOS_API_KEY",
] as const;

function configPresence(env: Bindings): Record<string, boolean> {
  const rec = env as unknown as Record<string, string | undefined>;
  const out: Record<string, boolean> = {};
  for (const key of REQUIRED_CONFIG_KEYS) out[key] = Boolean(rec[key]?.trim());
  return out;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("durable object probe timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

app.get("/ready", async (c) => {
  const cid = correlationId(c);
  const config = configPresence(c.env);
  const configOk = Object.values(config).every(Boolean);

  let doOk = false;
  let doError: string | null = null;
  try {
    // Cheap existing RPC (single indexed SELECT, no side effects) used purely
    // to confirm the Durable Object is alive and responding.
    await withTimeout(
      Promise.resolve(getGatewayStubForWaba(c.env, c.env.META_WABA_ID).getConfigValue("__readiness_probe__")),
      2000,
    );
    doOk = true;
  } catch (err) {
    doError = err instanceof Error ? err.message : "unknown error";
  }

  const ready = configOk && doOk;
  const status = ready ? 200 : 503;
  logEvent("readiness_check", cid, status, {
    configOk,
    doOk,
    missingConfig: Object.entries(config).filter(([, present]) => !present).map(([k]) => k).join(",") || null,
  });
  return c.json({ ok: ready, config, durableObject: { ok: doOk, error: doError } }, status);
});

app.get("/webhooks/meta", (c) => {
  const cid = correlationId(c);
  const cfg = getConfig(c.env);
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token && constantTimeEqual(token, cfg.META_WEBHOOK_VERIFY_TOKEN) && challenge) {
    logEvent("webhook_verify", cid, 200, { mode });
    return c.text(challenge, 200);
  }
  logEvent("webhook_verify", cid, 403, { mode: mode ?? null });
  return c.text("Forbidden", 403);
});

app.post("/webhooks/meta", async (c) => {
  // Note: logging happens right before each early return so the handler keeps
  // returning quickly — no extra I/O or awaits are added on this path.
  const cid = correlationId(c);
  const cfg = getConfig(c.env);
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? null;
  if (!(await verifyMetaSignature(rawBody, signature, cfg.META_APP_SECRET))) {
    logEvent("webhook_signature_invalid", cid, 401, { bodyBytes: rawBody.length });
    return c.json({ ok: false, error: "invalid signature" }, 401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    logEvent("webhook_invalid_json", cid, 400, { bodyBytes: rawBody.length });
    return c.json({ ok: false, error: "invalid json" }, 400);
  }
  const batches = mergeBatches([...parseMetaWebhookBatches(payload), ...parseMetaEchoesBatches(payload)]);
  const results = await Promise.all(
    batches.map((batch) => getGatewayStubForWaba(c.env, batch.wabaId).ingest(batch.events)),
  );
  const eventCount = batches.reduce((sum, batch) => sum + batch.events.length, 0);
  const received = results.reduce((sum, result) => sum + result.received, 0);
  logEvent("webhook_ingested", cid, 200, { eventCount, received, wabaCount: batches.length });
  return c.json({ ok: true, received });
});

app.use("/v1/*", async (c, next) => {
  const cid = correlationId(c);
  const path = new URL(c.req.url).pathname;
  const cfg = getConfig(c.env);
  const auth = c.req.header("authorization");
  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : c.req.header("x-api-key");
  if (!key || !constantTimeEqual(key, cfg.ECCOS_API_KEY)) {
    logEvent("v1_unauthorized", cid, 401, { path });
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  const isSendRequest = c.req.method === "POST" && /^\/v1\/wabas\/[^/]+\/messages$/.test(path);
  const wabaId = isSendRequest ? path.match(/^\/v1\/wabas\/([^/]+)\/messages$/)?.[1] : undefined;
  if (isSendRequest && c.env.SEND_RATE_LIMITER) {
    // Cloudflare Rate Limiting is per-location and eventually consistent:
    // good abuse/spike protection, not an exact global quota counter.
    const { success } = await c.env.SEND_RATE_LIMITER.limit({ key: `${key}:${wabaId}` });
    if (!success) {
      logEvent("v1_rate_limited", cid, 429, { path });
      return c.json({ ok: false, error: "rate limited" }, 429);
    }
  }
  await next();
});

async function sendMessageRoute(c: Context<{ Bindings: Bindings }>) {
  const cid = correlationId(c);
  const { wabaId, stub: gateway } = requestStub(c);
  const cfg = await requestConfig(c, gateway, wabaId);
  if (!cfg) return c.json({ ok: false, error: "WABA is not configured" }, 404);
  const json = await c.req.json().catch(() => null);
  if (
    !json ||
    typeof json !== "object" ||
    typeof (json as Record<string, unknown>).to !== "string" ||
    ((json as Record<string, unknown>).to as string).length < 5
  ) {
    logEvent("outbound_send", cid, 400, { reason: "invalid_body" });
    return c.json({ ok: false, error: "invalid body" }, 400);
  }
  const body = json as Record<string, unknown>;
  const recipient = body.to as string;
  // `messageType` (e.g. "text"/"template") is a safe enum-like field — the
  // recipient number and message content are never logged.
  const messageType = typeof body.type === "string" ? body.type : "unknown";
  const result = await sendMessage(cfg, body);
  if (!result.ok) {
    await gateway.logOutbound(null, recipient, JSON.stringify(body), "failed", JSON.stringify(result.error));
    logEvent("outbound_send", cid, 502, { messageType, ok: false });
    return c.json({ ok: false, error: result.error }, 502);
  }
  await gateway.logOutbound(result.id, recipient, JSON.stringify(body), "sent", null);
  logEvent("outbound_send", cid, 200, { messageType, messageId: result.id, ok: true });
  return c.json({ ok: true, messages: [{ id: result.id }] });
}

app.post("/v1/wabas/:wabaId/messages", sendMessageRoute);

// Right-to-erasure (GDPR Art. 17). The phone travels in the JSON body — never in
// the URL — so it cannot leak into request logs. Gated by the /v1/* auth above.
async function erasureRoute(c: Context<{ Bindings: Bindings }>) {
  const cid = correlationId(c);
  const { wabaId, stub: gateway } = requestStub(c);
  if (!(await requestConfig(c, gateway, wabaId))) {
    return c.json({ ok: false, error: "WABA is not configured" }, 404);
  }
  const json = await c.req.json().catch(() => null);
  const phone = json && typeof json === "object" ? (json as Record<string, unknown>).phone : undefined;
  if (typeof phone !== "string" || phone.trim().length === 0) {
    logEvent("privacy_erasure", cid, 400, { reason: "invalid_body" });
    return c.json({ ok: false, error: "invalid body: expected { phone: string }" }, 400);
  }
  const result = await gateway.eraseByPhone(phone);
  if (!result.ok) {
    logEvent("privacy_erasure", cid, 400, { reason: "invalid_phone" });
    return c.json(result, 400);
  }
  // SAFETY: log the per-table counts only — never the phone number itself.
  logEvent("privacy_erasure", cid, 200, { ...result.counts });
  return c.json(result);
}

app.post("/v1/wabas/:wabaId/privacy/erasure", erasureRoute);

async function templatesRoute(c: Context<{ Bindings: Bindings }>) {
  const cid = correlationId(c);
  const { wabaId, stub: gateway } = requestStub(c);
  const cfg = await requestConfig(c, gateway, wabaId);
  if (!cfg) return c.json({ ok: false, error: "WABA is not configured" }, 404);
  const n = Number(c.req.query("limit") ?? 100);
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 1000) : 100;
  const result = await listTemplates(cfg, limit);
  if (!result.ok) {
    logEvent("templates_list", cid, 502, { limit });
    return c.json({ ok: false, error: result.error }, 502);
  }
  const count =
    result.data && typeof result.data === "object" && Array.isArray((result.data as { data?: unknown }).data)
      ? (result.data as { data: unknown[] }).data.length
      : null;
  logEvent("templates_list", cid, 200, { limit, count });
  return c.json(result.data);
}

app.get("/v1/wabas/:wabaId/templates", templatesRoute);

export default app;
