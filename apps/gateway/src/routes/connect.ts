import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConfig } from "../config";
import { getGatewayStubForWaba } from "../gateway-stub";
import {
  exchangeCodeForToken,
  findWabaPhoneNumbers,
  findWabaPhoneNumbersForToken,
  listPhoneNumbers,
  subscribeApp,
} from "../meta/connect-api";
import { authenticateRequest } from "../tenant-auth";
import { getAppConfig, isMultiTenantEnabled, isTenantControlPlaneEnabled } from "../tenant-config";
import { getControlPlaneStub } from "../control-plane-stub";
import { constantTimeEqual } from "@eccos/core/signature";

type ConnectContext = Context<{ Bindings: Env }>;

/** Short-lived cookie carrying the OAuth `state` for the GET /connect CSRF check (F4a). */
const STATE_COOKIE = "eccos_connect_state";
const STATE_COOKIE_MAX_AGE_SECONDS = 300;

/**
 * The Meta redirect back to /connect is a top-level GET navigation, so a
 * `SameSite=Lax` cookie is sent along with it while still blocking CSRF forms
 * (POST) and cross-site subresource requests.
 */
function setOAuthStateCookie(c: ConnectContext, state: string): void {
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/connect",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
}

function clearOAuthStateCookie(c: ConnectContext): void {
  deleteCookie(c, STATE_COOKIE, { path: "/connect" });
}

function noStore(c: ConnectContext): void {
  c.header("Cache-Control", "no-store");
}

/** Constant-time comparison; missing query/cookie state always fails closed. */
export function oauthStateIsValid(queryState: string | null, cookieState: string | undefined): boolean {
  if (!queryState || !cookieState) return false;
  return constantTimeEqual(queryState, cookieState);
}

/** Mirrors the /v1/* auth check in worker.ts: Bearer prefix, else the raw x-api-key header. */
export function extractApiKey(
  authorizationHeader: string | undefined,
  apiKeyHeader: string | undefined,
): string | undefined {
  if (authorizationHeader?.startsWith("Bearer ")) return authorizationHeader.slice(7);
  return apiKeyHeader;
}

/** Same fail-closed contract as the /v1/* gate: no key, or a mismatching key, is unauthorized. */
export function isAuthorized(
  authorizationHeader: string | undefined,
  apiKeyHeader: string | undefined,
  expectedKey: string,
): boolean {
  const key = extractApiKey(authorizationHeader, apiKeyHeader);
  if (!key) return false;
  return constantTimeEqual(key, expectedKey);
}

type ExchangeResult =
  | {
      ok: true;
      waba_id: string;
      phone_number_id: string;
      display_phone_number: string;
    }
  | { ok: false; error: string };

type ConnectedPhone = {
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
};

type ExchangeBody = { code: string; state?: string; waba_id?: string; redirect_uri?: string };

type MultiExchangeResult =
  | {
      ok: true;
      waba_id: string;
      phone_number_id: string;
      display_phone_number: string;
      connected: ConnectedPhone[];
      warnings?: string[];
    }
  | { ok: false; error: string };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resultPage(result: ExchangeResult | MultiExchangeResult): string {
  const title = result.ok ? "Connected" : "Connect failed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} — Eccos</title></head>
<body>
<h1>${title}</h1>
<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
<p><a href="/connect">Back to /connect</a></p>
</body></html>`;
}

function oauthUrl(
  cfg: { META_APP_ID?: string; META_ES_CONFIG_ID?: string; META_GRAPH_VERSION?: string },
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: cfg.META_APP_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    config_id: cfg.META_ES_CONFIG_ID ?? "",
    override_default_response_type: "true",
    state,
  });
  params.set(
    "extras",
    JSON.stringify({
      setup: {},
      featureType: "whatsapp_business_app_onboarding",
      sessionInfoVersion: "3",
    }),
  );
  return `https://www.facebook.com/${cfg.META_GRAPH_VERSION ?? "v24.0"}/dialog/oauth?${params.toString()}`;
}

function connectPage(oauthUrlValue: string, redirectUri: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connect WhatsApp — Eccos</title></head>
<body>
<h1>Connect WhatsApp</h1>
<p>Manual OAuth flow. Redirect URI: <code>${escapeHtml(redirectUri)}</code></p>
<p><a href="${escapeHtml(oauthUrlValue)}">Connect WhatsApp (coexistence)</a></p>
</body></html>`;
}

function connectConfig(c: ConnectContext) {
  const cfg = getAppConfig(c.env);
  if (!cfg.META_APP_ID) throw new Error("META_APP_ID is required for /connect");
  if (!cfg.META_ES_CONFIG_ID) throw new Error("META_ES_CONFIG_ID is required for /connect");
  return cfg;
}

function parseExchangeBody(value: unknown): ExchangeBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || record.code.trim() === "") return null;
  for (const key of ["state", "waba_id", "redirect_uri"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") return null;
  }
  const code = record.code.trim();
  const state = typeof record.state === "string" ? record.state.trim() : undefined;
  const waba_id = typeof record.waba_id === "string" ? record.waba_id.trim() || undefined : undefined;
  const redirect_uri = typeof record.redirect_uri === "string" ? record.redirect_uri.trim() || undefined : undefined;
  return { code, ...(state ? { state } : {}), ...(waba_id ? { waba_id } : {}), ...(redirect_uri ? { redirect_uri } : {}) };
}

async function exchangeAndPersist(
  c: ConnectContext,
  code: string,
  wabaId: string | undefined,
  redirectUri?: string,
): Promise<ExchangeResult> {
  const cfg = getConfig(c.env);

  try {
    const businessToken = await exchangeCodeForToken(cfg, code, redirectUri);
    let resolvedWabaId = wabaId;
    let phones = resolvedWabaId ? await listPhoneNumbers(cfg, resolvedWabaId, businessToken) : [];
    if (!resolvedWabaId || phones.length === 0) {
      const inferred = await findWabaPhoneNumbers(cfg, businessToken);
      if (!inferred) return { ok: false, error: "could not infer WABA from token" };
      resolvedWabaId = inferred.wabaId;
      phones = inferred.phones;
    }

    const phoneNumberId = phones[0]?.id;
    if (!phoneNumberId) return { ok: false, error: "no phone numbers under WABA" };

    const callbackUrl = new URL("/webhooks/meta", c.req.url).href;
    const displayPhoneNumber = phones[0]?.display_phone_number ?? "";
    const stub = getGatewayStubForWaba(c.env, resolvedWabaId);
    await stub.saveConfig({
      META_WABA_ID: resolvedWabaId,
      META_PHONE_NUMBER_ID: phoneNumberId,
      DISPLAY_PHONE_NUMBER: displayPhoneNumber,
      CONNECTED_AT: String(Date.now()),
      META_WEBHOOK_CALLBACK_URL: callbackUrl,
    });
    await subscribeApp(cfg, resolvedWabaId, businessToken, callbackUrl);

    return {
      ok: true,
      waba_id: resolvedWabaId,
      phone_number_id: phoneNumberId,
      display_phone_number: displayPhoneNumber,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/**
 * Multi-tenant exchange: discover every WABA/phone the business token can see,
 * register each in the control plane (credentials + callback live there), store
 * only non-secret connection metadata in the per-WABA gateway Durable Object,
 * and subscribe each WABA on Meta. Ownership conflicts fail before any mutation
 * of another account.
 */
async function exchangeAndRegisterAll(
  c: ConnectContext,
  code: string,
  accountId: string,
  redirectUri?: string,
  wabaSelector?: string,
): Promise<MultiExchangeResult> {
  try {
    const appConfig = getAppConfig(c.env);
    const businessToken = await exchangeCodeForToken(appConfig, code, redirectUri);
    const discovered = await findWabaPhoneNumbersForToken(appConfig, businessToken);
    if (discovered.length === 0) return { ok: false, error: "could not infer WABA from token" };
    if (wabaSelector && !discovered.some((m) => m.wabaId === wabaSelector)) {
      return { ok: false, error: `waba "${wabaSelector}" is not owned by the initiating account` };
    }
    const matches = wabaSelector ? discovered.filter((match) => match.wabaId === wabaSelector) : discovered;

    const callbackUrl = new URL("/webhooks/meta", c.req.url).href;
    const controlPlane = getControlPlaneStub(c.env);

    for (const match of matches) {
      const owned = await controlPlane.getWabaById(match.wabaId);
      if (owned && owned.accountId !== accountId) {
        return { ok: false, error: `waba "${match.wabaId}" is already registered to another account` };
      }
    }

    const registrations = await controlPlane.registerWabas(
      matches.map((match) => ({
        accountId,
        wabaId: match.wabaId,
        metaAccessToken: businessToken,
        callbackUrl,
        phones: match.phones.map((p) => ({
          phoneNumberId: p.id,
          displayPhoneNumber: p.display_phone_number ?? "",
        })),
      })),
    );

    const warnings: string[] = [];
    for (const [index, match] of matches.entries()) {
      const registration = registrations[index];
      if (!registration) return { ok: false, error: "WABA registration failed" };
      const stub = getGatewayStubForWaba(c.env, match.wabaId);
      try {
        await stub.saveConfig({
          META_WABA_ID: match.wabaId,
          META_PHONE_NUMBER_ID: match.phones[0]?.id ?? "",
          DISPLAY_PHONE_NUMBER: match.phones[0]?.display_phone_number ?? "",
          CONNECTED_AT: String(Date.now()),
          META_WEBHOOK_CALLBACK_URL: callbackUrl,
        });
      } catch (error) {
        warnings.push(`${match.wabaId}: gateway configuration sync failed (${errorMessage(error)})`);
      }
      try {
        await subscribeApp(appConfig, match.wabaId, businessToken, callbackUrl);
      } catch (error) {
        warnings.push(`${match.wabaId}: Meta webhook subscription failed (${errorMessage(error)})`);
      }
    }

    const primary = matches[0];
    if (!primary) return { ok: false, error: "WABA registration failed" };
    return {
      ok: true,
      waba_id: primary.wabaId,
      phone_number_id: primary.phones[0]?.id ?? "",
      display_phone_number: primary.phones[0]?.display_phone_number ?? "",
      connected: matches.flatMap((m) =>
        m.phones.map((p) => ({
          waba_id: m.wabaId,
          phone_number_id: p.id,
          display_phone_number: p.display_phone_number ?? "",
        })),
      ),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (e) {
    const message = errorMessage(e);
    return { ok: false, error: message };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function connectRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/connect/start", async (c) => {
    if (!isTenantControlPlaneEnabled(c.env)) return c.json({ ok: false, error: "not found" }, 404);
    const account = await authenticateRequest(
      c.env,
      c.req.header("authorization") ?? undefined,
      c.req.header("x-api-key") ?? undefined,
    );
    if (!account) return c.json({ ok: false, error: "unauthorized" }, 401);
    try {
      connectConfig(c);
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : "connect is not configured" }, 503);
    }
    const state = crypto.randomUUID();
    const expiresAt = Date.now() + STATE_COOKIE_MAX_AGE_SECONDS * 1000;
    await getControlPlaneStub(c.env).startConnectState(state, account.accountId, expiresAt);
    const startUrl = new URL("/connect", c.req.url);
    startUrl.searchParams.set("state", state);
    noStore(c);
    return c.json({ ok: true, url: startUrl.href, state, expiresAt });
  });

  app.get("/connect", async (c) => {
    const url = new URL(c.req.url);
    const redirectUri = new URL("/connect", c.req.url).href;
    const code = url.searchParams.get("code");
    if (code) {
      const queryState = url.searchParams.get("state");
      const cookieState = getCookie(c, STATE_COOKIE);
      clearOAuthStateCookie(c);
      if (!oauthStateIsValid(queryState, cookieState)) {
        return c.html(resultPage({ ok: false, error: "invalid or missing OAuth state" }), 400);
      }
      if (isTenantControlPlaneEnabled(c.env)) {
        const stateRecord = await getControlPlaneStub(c.env).consumeConnectStateRecord(queryState ?? "");
        if (!stateRecord) {
          return c.html(resultPage({ ok: false, error: "invalid or expired OAuth state" }), 400);
        }
        const result = await exchangeAndRegisterAll(c, code, stateRecord.accountId, redirectUri);
        noStore(c);
        return c.html(resultPage(result), result.ok ? 200 : 502);
      }
      const result = await exchangeAndPersist(c, code, undefined, redirectUri);
      noStore(c);
      return c.html(resultPage(result), result.ok ? 200 : 502);
    }

    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description") ?? error;
      return c.html(resultPage({ ok: false, error: description }), 400);
    }

    if (isTenantControlPlaneEnabled(c.env)) {
      const handoffState = url.searchParams.get("state");
      let state = handoffState?.trim() || "";
      if (state) {
        const accountId = await getControlPlaneStub(c.env).getConnectStateAccount(state);
        if (!accountId) {
          return c.html(resultPage({ ok: false, error: "invalid or expired OAuth state" }), 400);
        }
      } else {
        const account = await authenticateRequest(
          c.env,
          c.req.header("authorization") ?? undefined,
          c.req.header("x-api-key") ?? undefined,
        );
        if (!account) {
          return c.html(resultPage({ ok: false, error: "unauthorized" }), 401);
        }
        state = crypto.randomUUID();
        await getControlPlaneStub(c.env).startConnectState(
          state,
          account.accountId,
          Date.now() + STATE_COOKIE_MAX_AGE_SECONDS * 1000,
        );
      }
      setOAuthStateCookie(c, state);
      let cfg: ReturnType<typeof connectConfig>;
      try {
        cfg = connectConfig(c);
      } catch (error) {
        return c.html(resultPage({ ok: false, error: error instanceof Error ? error.message : "connect is not configured" }), 503);
      }
      return c.html(connectPage(oauthUrl(cfg, redirectUri, state), redirectUri));
    }

    let cfg: ReturnType<typeof connectConfig>;
    try {
      cfg = connectConfig(c);
    } catch (error) {
      return c.html(resultPage({ ok: false, error: error instanceof Error ? error.message : "connect is not configured" }), 503);
    }
    const state = crypto.randomUUID();
    setOAuthStateCookie(c, state);
    return c.html(connectPage(oauthUrl(cfg, redirectUri, state), redirectUri));
  });

  app.post("/connect/exchange", async (c) => {
    // Public-network reachable, but mutates the connected WABA/phone config (F4b):
    // gate it before touching the exchange. Multi-tenant requires an account API
    // key and resolves the account from the control plane; legacy uses the env key.
    const authorizationHeader = c.req.header("authorization") ?? undefined;
    const apiKeyHeader = c.req.header("x-api-key") ?? undefined;

    if (isTenantControlPlaneEnabled(c.env)) {
      const account = await authenticateRequest(c.env, authorizationHeader, apiKeyHeader);
      if (!account) {
        return c.json({ ok: false, error: "unauthorized" }, 401);
      }
      let body: ExchangeBody | null;
      try {
        body = parseExchangeBody(await c.req.json());
      } catch {
        return c.json({ ok: false, error: "invalid JSON body" }, 400);
      }
      if (!body) return c.json({ ok: false, error: "invalid JSON body" }, 400);
      const { code, state, waba_id, redirect_uri } = body;
      if (!state) return c.json({ ok: false, error: "missing state" }, 400);
      try {
        connectConfig(c);
      } catch (error) {
        return c.json({ ok: false, error: error instanceof Error ? error.message : "connect is not configured" }, 503);
      }
      const controlPlane = getControlPlaneStub(c.env);
      const stateRecord = await controlPlane.getConnectStateAccount(state);
      if (stateRecord !== account.accountId) return c.json({ ok: false, error: "invalid or expired OAuth state" }, 400);
      const expectedRedirectUri = new URL("/connect", c.req.url).href;
      if (redirect_uri !== undefined && redirect_uri !== expectedRedirectUri) {
        return c.json({ ok: false, error: "redirect_uri does not match the connect origin" }, 400);
      }
      const consumedAccountId = await controlPlane.consumeConnectStateRecord(state);
      if (!consumedAccountId || consumedAccountId.accountId !== account.accountId) {
        return c.json({ ok: false, error: "invalid or expired OAuth state" }, 400);
      }
      const result = await exchangeAndRegisterAll(c, code, account.accountId, expectedRedirectUri, waba_id);
      noStore(c);
      return c.json(result, result.ok ? 200 : 502);
    }

    const cfg = getConfig(c.env);
    if (!isAuthorized(authorizationHeader, apiKeyHeader, cfg.ECCOS_API_KEY)) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    let body: ExchangeBody | null;
    try {
      body = parseExchangeBody(await c.req.json());
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (!body) return c.json({ ok: false, error: "invalid JSON body" }, 400);
    const { code, waba_id, redirect_uri } = body;
    try {
      connectConfig(c);
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : "connect is not configured" }, 503);
    }
    const result = await exchangeAndPersist(c, code, waba_id, redirect_uri);
    noStore(c);
    return c.json(result, result.ok ? 200 : 502);
  });

  return app;
}
