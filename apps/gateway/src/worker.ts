import { Hono, type Context } from "hono";
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
import { authenticateRequest, extractApiKey, type RequestAccount } from "./tenant-auth";
import { getAppConfig, tenantConfig } from "./tenant-config";
import { getControlPlaneStub as getControlPlane } from "./control-plane-stub";
import { WABA_ID_PATTERN, type AccountWaba } from "./control-plane";
import { validateSubscriberUrl } from "./gateway";
import { reconcilePendingWabas, reconcileWaba } from "./provisioning";

export { EccosGateway } from "./gateway";
export { EccosControlPlane } from "./control-plane";
export { GatewayRPC } from "./rpc";

type Bindings = Env;
type AppContext = Context<{ Bindings: Bindings; Variables: { account: RequestAccount } }>;

const app = new Hono<{ Bindings: Bindings; Variables: { account: RequestAccount } }>();

app.route("/", connectRoutes());

function requestedWabaId(c: { req: { param(name: string): string } }): string {
  const wabaId = c.req.param("wabaId");
  if (!wabaId) throw new Error("WABA route is required");
  return wabaId;
}

function accountIdParam(c: { req: { param(name: string): string } }): string {
  const accountId = c.req.param("accountId") ?? "";
  if (!accountId) throw new Error("account route is required");
  return accountId;
}

async function ownedWaba(
  env: Bindings,
  account: RequestAccount,
  wabaId: string,
): Promise<AccountWaba | null> {
  return getControlPlane(env).getWaba(account.accountId, wabaId);
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

function isAdminRequest(path: string): boolean {
  return (
    path === "/v1/accounts" ||
    /^\/v1\/accounts\/[^/]+\/keys$/.test(path) ||
    /^\/v1\/accounts\/[^/]+\/keys\/[^/]+\/revoke$/.test(path) ||
    /^\/v1\/accounts\/[^/]+\/wabas$/.test(path) ||
    /^\/v1\/accounts\/[^/]+\/wabas\/[^/]+\/reconcile$/.test(path)
  );
}

/** Resolves the target phone for a send: the URL selector wins, falling back to
 * the body `phone_number_id`. Returns null when no selector is present (only
 * legal for single-phone WABAs — enforced by the caller). */
function phoneSelector(
  c: { req: { param(name: string): string } },
  body: Record<string, unknown>,
): { phoneNumberId: string | null } {
  const phonePath = c.req.param("phoneNumberId")?.trim() || null;
  const phoneBody = typeof body.phone_number_id === "string" ? body.phone_number_id.trim() || null : null;
  if (phonePath && phoneBody && phonePath !== phoneBody) throw new Error("phone selector mismatch");
  return { phoneNumberId: phonePath ?? phoneBody };
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

function noStore(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "no-store");
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
//   - the control plane (Durable Object) responds to a cheap RPC call, and
//   - the app-level Meta signature/verify secrets are present (booleans + key
//     names only — never values).
// The deployment is account-scoped by default, so per-WABA credentials are
// optional runtime state: a gateway with an empty registry is still healthy,
// and a missing app-level Meta secret is reported without breaking the deploy.
// Returns 200 when both checks pass, 503 otherwise.

/** App-level prerequisites — the only required (non-optional, no-default)
 * secrets of the account-scoped Workers target. */
const REQUIRED_CONFIG_KEYS = ["META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"] as const;

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
    await withTimeout(Promise.resolve(getControlPlane(c.env).getHealth()), 2000);
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
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const expectedToken = getAppConfig(c.env).META_WEBHOOK_VERIFY_TOKEN;
  if (mode === "subscribe" && token && constantTimeEqual(token, expectedToken) && challenge) {
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
  const rawBody = await c.req.text();
  let appSecret: string;
  try {
    appSecret = getAppConfig(c.env).META_APP_SECRET;
  } catch (error) {
    logEvent("webhook_misconfigured", cid, 200, {
      bodyBytes: rawBody.length,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return c.json({ ok: true, received: 0 }, 200);
  }
  const signature = c.req.header("x-hub-signature-256") ?? null;
  if (!(await verifyMetaSignature(rawBody, signature, appSecret))) {
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
  let batches = mergeBatches([...parseMetaWebhookBatches(payload), ...parseMetaEchoesBatches(payload)]);
  // Only ingest WABAs AND phone numbers registered in the control plane;
  // unregistered batches are ignored while the webhook still answers 200.
  const cp = getControlPlane(c.env);
  const known: MetaWebhookBatch[] = [];
  let ignoredEventCount = 0;
  for (const batch of batches) {
    if (!WABA_ID_PATTERN.test(batch.wabaId)) {
      ignoredEventCount += batch.events.length;
      continue;
    }
    try {
      const waba = await cp.getWabaById(batch.wabaId);
      if (!waba || waba.status !== "active") {
        ignoredEventCount += batch.events.length;
        continue;
      }
      if (batch.phoneNumberId !== null && !waba.phones.some((p) => p.phoneNumberId === batch.phoneNumberId)) {
        ignoredEventCount += batch.events.length;
        continue;
      }
      known.push(batch);
    } catch {
      ignoredEventCount += batch.events.length;
    }
  }
  batches = known;
  if (batches.length === 0) {
    logEvent("webhook_ignored", cid, 200, { bodyBytes: rawBody.length, ignoredEventCount });
    return c.json({ ok: true, received: 0 });
  }
  const results = await Promise.all(
    batches.map((batch) => getGatewayStubForWaba(c.env, batch.wabaId).ingest(batch.events)),
  );
  const eventCount = batches.reduce((sum, batch) => sum + batch.events.length, 0);
  const received = results.reduce((sum, result) => sum + result.received, 0);
  logEvent("webhook_ingested", cid, 200, { eventCount, received, wabaCount: batches.length });
  return c.json({ ok: true, received });
});

// --- /v1 auth ----------------------------------------------------------------

app.use("/v1/*", async (c, next) => {
  const cid = correlationId(c);
  const path = new URL(c.req.url).pathname;
  const auth = c.req.header("authorization") ?? undefined;
  const apiKeyHeader = c.req.header("x-api-key") ?? undefined;
  const rawKey = extractApiKey(auth, apiKeyHeader);

  if (isAdminRequest(path)) {
    const adminKey = (c.env as { ECCOS_ADMIN_API_KEY?: string }).ECCOS_ADMIN_API_KEY ?? "";
    if (!rawKey || !constantTimeEqual(adminKey, rawKey)) {
      logEvent("v1_unauthorized", cid, 401, { path, scope: "admin" });
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    await next();
    return;
  }

  const account = await authenticateRequest(c.env, auth, apiKeyHeader);
  if (!account) {
    logEvent("v1_unauthorized", cid, 401, { path, scope: "account" });
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  c.set("account", account);

  if (c.req.method === "POST" && /^\/v1\/wabas\/[^/]+(\/phones\/[^/]+)?\/messages$/.test(path)) {
    if (c.env.SEND_RATE_LIMITER) {
      // Cloudflare Rate Limiting is per-location and eventually consistent:
      // good abuse/spike protection, not an exact global quota counter.
      const sendWabaId = path.match(/^\/v1\/wabas\/([^/]+)/)?.[1] ?? "unknown";
      const rateKey = `${account.accountId}:${sendWabaId}`;
      const { success } = await c.env.SEND_RATE_LIMITER.limit({ key: rateKey });
      if (!success) {
        logEvent("v1_rate_limited", cid, 429, { path });
        return c.json({ ok: false, error: "rate limited" }, 429);
      }
    }
  }
  await next();
});

// --- Admin bootstrap endpoints ------------------------------------------------

async function createAccountRoute(c: AppContext) {
  const cid = correlationId(c);
  let body: { accountId?: string; name?: string };
  try {
    const value = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    body = value as { accountId?: string; name?: string };
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  try {
    const result = await getControlPlane(c.env).createAccount(body);
    logEvent("account_created", cid, 201, { accountId: result.account.accountId });
    // The raw API key is returned exactly once — it is never stored.
    noStore(c);
    return c.json(result, 201);
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "internal error" }, 400);
  }
}

async function issueKeyRoute(c: AppContext) {
  const cid = correlationId(c);
  const accountId = accountIdParam(c);
  let body: { label?: string };
  try {
    const value = await c.req.json().catch(() => ({}));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    body = value as { label?: string };
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  try {
    const result = await getControlPlane(c.env).issueApiKey(accountId, body.label);
    logEvent("key_issued", cid, 201, { accountId });
    noStore(c);
    return c.json(result, 201);
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "internal error" }, 400);
  }
}

async function revokeKeyRoute(c: AppContext) {
  const cid = correlationId(c);
  const accountId = accountIdParam(c);
  const keyId = c.req.param("keyId") ?? "";
  if (!keyId) return c.json({ ok: false, error: "keyId is required" }, 400);
  try {
    const revoked = await getControlPlane(c.env).revokeApiKey(accountId, keyId);
    if (!revoked) {
      logEvent("key_revoke", cid, 404, { accountId });
      return c.json({ ok: false, error: "key not found or already revoked" }, 404);
    }
    logEvent("key_revoke", cid, 200, { accountId });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "internal error" }, 400);
  }
}

/** Registers an existing WABA + phones with the account's Meta credentials.
 * Admin-only; the token is stored in the control plane and never echoed. */
async function registerWabaRoute(c: AppContext) {
  const cid = correlationId(c);
  const accountId = accountIdParam(c);
  let body: Record<string, unknown>;
  try {
    const value = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    body = value as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const wabaIdValue = body.wabaId ?? body.waba_id;
  const tokenValue = body.meta_access_token ?? body.metaAccessToken;
  const wabaId = typeof wabaIdValue === "string" ? wabaIdValue.trim() : "";
  const metaAccessToken = typeof tokenValue === "string" ? tokenValue.trim() : "";
  if (!wabaId || !metaAccessToken || !Array.isArray(body.phones) || body.phones.length === 0) {
    return c.json({ ok: false, error: "wabaId and meta_access_token are required" }, 400);
  }
  const phones: Array<{ phoneNumberId: string; displayPhoneNumber?: string }> = [];
  for (const value of body.phones) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return c.json({ ok: false, error: "invalid phone" }, 400);
    }
    const phone = value as Record<string, unknown>;
    if (typeof phone.phoneNumberId !== "string" || phone.phoneNumberId.trim() === "") {
      return c.json({ ok: false, error: "phoneNumberId is required" }, 400);
    }
    if (phone.displayPhoneNumber !== undefined && typeof phone.displayPhoneNumber !== "string") {
      return c.json({ ok: false, error: "displayPhoneNumber must be a string" }, 400);
    }
    phones.push({
      phoneNumberId: phone.phoneNumberId,
      ...(typeof phone.displayPhoneNumber === "string" ? { displayPhoneNumber: phone.displayPhoneNumber } : {}),
    });
  }
  const callbackUrlValue = body.callback_url ?? body.callbackUrl;
  if (callbackUrlValue !== undefined && typeof callbackUrlValue !== "string") {
    return c.json({ ok: false, error: "callbackUrl must be a string" }, 400);
  }
  const callbackUrl =
    typeof callbackUrlValue === "string" && callbackUrlValue.trim() !== ""
      ? callbackUrlValue
      : new URL("/webhooks/meta", c.req.url).href;
  const subscriberUrlValue = body.subscriber_webhook_url ?? body.subscriberUrl;
  if (subscriberUrlValue !== undefined && typeof subscriberUrlValue !== "string") {
    return c.json({ ok: false, error: "subscriber_webhook_url must be a string" }, 400);
  }
  const subscriberSecretValue = body.subscriber_secret ?? body.subscriberSecret;
  if (subscriberSecretValue !== undefined && typeof subscriberSecretValue !== "string") {
    return c.json({ ok: false, error: "subscriber_secret must be a string" }, 400);
  }
  let subscriberUrl: string | undefined;
  try {
    if (typeof subscriberUrlValue === "string" && subscriberUrlValue.trim() !== "") {
      subscriberUrl = validateSubscriberUrl(subscriberUrlValue);
    }
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "invalid subscriber URL" }, 400);
  }
  const subscriberSecret =
    typeof subscriberSecretValue === "string" && subscriberSecretValue.trim() !== ""
      ? subscriberSecretValue.trim()
      : undefined;
  try {
    const result = await getControlPlane(c.env).beginWabaProvisioning({
      accountId,
      wabaId,
      metaAccessToken,
      callbackUrl,
      phones,
    });
    logEvent("waba_provisioning_started", cid, 202, {
      accountId,
      phoneCount: result.phones.length,
    });
    const warnings: string[] = [];
    if (subscriberUrl || subscriberSecret) {
      const gateway = getGatewayStubForWaba(c.env, result.waba.wabaId);
      try {
        await gateway.saveConfig({
          ...(subscriberUrl ? { SUBSCRIBER_WEBHOOK_URL: subscriberUrl } : {}),
          ...(subscriberSecret ? { SUBSCRIBER_SECRET: subscriberSecret } : {}),
        });
      } catch (error) {
        warnings.push(`subscriber configuration sync failed (${errorMessage(error)})`);
      }
    }
    // Never echo the token (or any credential) back to the caller.
    noStore(c);
    const responseStatus = result.waba.status === "active" ? 200 : 202;
    return c.json({
      waba: {
        accountId: result.waba.accountId,
        wabaId: result.waba.wabaId,
        callbackUrl: result.waba.callbackUrl,
        createdAt: result.waba.createdAt,
        status: result.waba.status,
        provisioningError: result.waba.provisioningError,
        phones: result.phones,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    }, responseStatus);
  } catch (err) {
    const error = errorMessage(err);
    return c.json({ ok: false, error }, /already registered to another account/.test(error) ? 409 : 400);
  }
}

async function reconcileWabaRoute(c: AppContext) {
  const cid = correlationId(c);
  const accountId = accountIdParam(c);
  const wabaId = requestedWabaId(c);
  try {
    const result = await reconcileWaba(c.env, accountId, wabaId);
    if (!result.waba) {
      logEvent("waba_reconcile", cid, 404, { accountId });
      return c.json({ ok: false, error: "WABA is not configured" }, 404);
    }
    const responseStatus = result.waba.status === "active" && !result.error ? 200 : 202;
    logEvent("waba_reconcile", cid, responseStatus, {
      accountId,
      status: result.waba.status,
    });
    noStore(c);
    return c.json({
      waba: {
        accountId: result.waba.accountId,
        wabaId: result.waba.wabaId,
        callbackUrl: result.waba.callbackUrl,
        createdAt: result.waba.createdAt,
        status: result.waba.status,
        provisioningError: result.waba.provisioningError ?? result.error,
        phones: result.waba.phones,
      },
    }, responseStatus);
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) }, 400);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

app.post("/v1/accounts", createAccountRoute);
app.post("/v1/accounts/:accountId/keys", issueKeyRoute);
app.post("/v1/accounts/:accountId/keys/:keyId/revoke", revokeKeyRoute);
app.post("/v1/accounts/:accountId/wabas", registerWabaRoute);
app.post("/v1/accounts/:accountId/wabas/:wabaId/reconcile", reconcileWabaRoute);

// --- Stateful per-account routes ----------------------------------------------

/** Resolves the WABA + phone for a send, enforcing account ownership,
 * registered-phone membership, and the single-phone compatibility rule.
 * Returns the Meta-bound body (selector stripped). */
async function tenantSendTarget(
  c: AppContext,
): Promise<
  | { ok: true; waba: AccountWaba; phoneNumberId: string; metaAccessToken: string; metaBody: Record<string, unknown> }
  | { ok: false; status: 400 | 404; error: string }
> {
  const account = c.get("account");
  const wabaId = requestedWabaId(c);
  const waba = await ownedWaba(c.env, account, wabaId);
  if (!waba) return { ok: false, status: 404, error: "WABA is not configured" };
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    !body ||
    typeof body !== "object" ||
    typeof body.to !== "string" ||
    body.to.length < 5
  ) {
    return { ok: false, status: 400, error: "invalid body" };
  }
  let selector: { phoneNumberId: string | null };
  try {
    selector = phoneSelector(c, body);
  } catch {
    return { ok: false, status: 400, error: "phone selector mismatch" };
  }
  let phoneNumberId: string;
  if (selector.phoneNumberId) {
    phoneNumberId = selector.phoneNumberId;
  } else {
    // Single-phone WABA compatibility: no selector required only when there
    // is exactly one registered number; otherwise the send is ambiguous.
    if (waba.phones.length !== 1) {
      return {
        ok: false,
        status: 400,
        error: "phoneNumberId is required when a WABA has more than one phone",
      };
    }
    phoneNumberId = waba.phones[0]?.phoneNumberId ?? "";
  }
  if (!waba.phones.some((p) => p.phoneNumberId === phoneNumberId)) {
    return { ok: false, status: 404, error: "phone number is not registered to this WABA" };
  }
  const metaBody = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "phone_number_id"));
  return { ok: true, waba, phoneNumberId, metaAccessToken: waba.metaAccessToken, metaBody };
}

async function sendMessageRoute(c: AppContext) {
  const cid = correlationId(c);
  const account = c.get("account") ?? null;
  if (!account) return c.json({ ok: false, error: "unauthorized" }, 401);
  const target = await tenantSendTarget(c);
  if (!target.ok) {
    logEvent("outbound_send", cid, target.status, { reason: "invalid_target" });
    return c.json({ ok: false, error: target.error }, target.status);
  }
  const cfg = tenantConfig(getAppConfig(c.env), {
    wabaId: target.waba.wabaId,
    phoneNumberId: target.phoneNumberId,
    metaAccessToken: target.metaAccessToken,
  });
  const recipient = target.metaBody.to as string;
  const messageType = typeof target.metaBody.type === "string" ? target.metaBody.type : "unknown";
  const result = await sendMessage(cfg, target.metaBody);
  const stub = getGatewayStubForWaba(c.env, target.waba.wabaId);
  if (!result.ok) {
    await stub.logOutbound(
      null,
      recipient,
      JSON.stringify(target.metaBody),
      "failed",
      JSON.stringify(result.error),
      target.phoneNumberId,
    );
    logEvent("outbound_send", cid, 502, { messageType, ok: false });
    return c.json({ ok: false, error: result.error }, 502);
  }
  await stub.logOutbound(result.id, recipient, JSON.stringify(target.metaBody), "sent", null, target.phoneNumberId);
  logEvent("outbound_send", cid, 200, { messageType, messageId: result.id, ok: true });
  return c.json({ ok: true, messages: [{ id: result.id }] });
}

app.post("/v1/wabas/:wabaId/messages", sendMessageRoute);
app.post("/v1/wabas/:wabaId/phones/:phoneNumberId/messages", sendMessageRoute);

// Right-to-erasure (GDPR Art. 17). The phone travels in the JSON body — never in
// the URL — so it cannot leak into request logs. Gated by the /v1/* auth above.
async function erasureRoute(c: AppContext) {
  const cid = correlationId(c);
  const account = c.get("account") ?? null;
  const wabaId = requestedWabaId(c);
  const json = await c.req.json().catch(() => null);
  const phone = json && typeof json === "object" ? (json as Record<string, unknown>).phone : undefined;
  if (typeof phone !== "string" || phone.trim().length === 0) {
    logEvent("privacy_erasure", cid, 400, { reason: "invalid_body" });
    return c.json({ ok: false, error: "invalid body: expected { phone: string }" }, 400);
  }
  if (!account) return c.json({ ok: false, error: "unauthorized" }, 401);
  const waba = await ownedWaba(c.env, account, wabaId);
  if (!waba) return c.json({ ok: false, error: "WABA is not configured" }, 404);
  const result = await getGatewayStubForWaba(c.env, waba.wabaId).eraseByPhone(phone);
  if (!result.ok) {
    logEvent("privacy_erasure", cid, 400, { reason: "invalid_phone" });
    return c.json(result, 400);
  }
  // SAFETY: log the per-table counts only — never the phone number itself.
  logEvent("privacy_erasure", cid, 200, { ...result.counts });
  return c.json(result);
}

app.post("/v1/wabas/:wabaId/privacy/erasure", erasureRoute);

async function templatesRoute(c: AppContext) {
  const cid = correlationId(c);
  const account = c.get("account") ?? null;
  const wabaId = requestedWabaId(c);
  const n = Number(c.req.query("limit") ?? 100);
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 1000) : 100;
  if (!account) return c.json({ ok: false, error: "unauthorized" }, 401);
  const waba = await ownedWaba(c.env, account, wabaId);
  if (!waba) return c.json({ ok: false, error: "WABA is not configured" }, 404);
  const cfg = tenantConfig(getAppConfig(c.env), {
    wabaId: waba.wabaId,
    phoneNumberId: waba.phones[0]?.phoneNumberId ?? "",
    metaAccessToken: waba.metaAccessToken,
  });
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

app.get("/v1/wabas/:wabaId/export", async (c) => {
  const cid = correlationId(c);
  const account = c.get("account") ?? null;
  const wabaId = requestedWabaId(c);
  if (!account) return c.json({ ok: false, error: "unauthorized" }, 401);
  const waba = await ownedWaba(c.env, account, wabaId);
  if (!waba) return c.json({ ok: false, error: "WABA is not configured" }, 404);
  const stub = getGatewayStubForWaba(c.env, waba.wabaId);
  const exported = await stub.exportData();
  logEvent("export", cid, 200, {
    inbound: exported.inbound.length,
    outbound: exported.outbound.length,
    deliveries: exported.deliveries.length,
  });
  return c.json({ ok: true, data: exported });
});

const worker = {
  fetch: app.fetch,
  scheduled: async (_controller: ScheduledController, env: Bindings): Promise<void> => {
    await reconcilePendingWabas(env);
  },
};

export default worker;
