import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConfig } from "../config";
import { exchangeCodeForToken, findWabaPhoneNumbers, listPhoneNumbers, subscribeApp } from "../meta/connect-api";
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resultPage(result: ExchangeResult): string {
  const title = result.ok ? "Connected" : "Connect failed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} — Eccos</title></head>
<body>
<h1>${title}</h1>
<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
<p><a href="/connect">Back to /connect</a></p>
</body></html>`;
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
    await subscribeApp(cfg, resolvedWabaId, businessToken, callbackUrl);

    const displayPhoneNumber = phones[0]?.display_phone_number ?? "";
    const stub = c.env.ECCOS.get(c.env.ECCOS.idFromName("singleton"));
    await stub.saveConfig({
      META_WABA_ID: resolvedWabaId,
      META_PHONE_NUMBER_ID: phoneNumberId,
      DISPLAY_PHONE_NUMBER: displayPhoneNumber,
      CONNECTED_AT: String(Date.now()),
    });

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

export function connectRoutes() {
  const app = new Hono<{ Bindings: Env }>();

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
      const result = await exchangeAndPersist(c, code, undefined, redirectUri);
      return c.html(resultPage(result), result.ok ? 200 : 502);
    }

    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description") ?? error;
      return c.html(resultPage({ ok: false, error: description }), 400);
    }

    const cfg = getConfig(c.env);
    const appId = cfg.META_APP_ID ?? "";
    const configId = cfg.META_ES_CONFIG_ID ?? "";
    const state = crypto.randomUUID();
    setOAuthStateCookie(c, state);
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "code",
      config_id: configId,
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
    const oauthUrl = `https://www.facebook.com/${cfg.META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;

    return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Connect WhatsApp — Eccos</title></head>
<body>
<h1>Connect WhatsApp</h1>
<p>Manual OAuth flow. Redirect URI: <code>${escapeHtml(redirectUri)}</code></p>
<p><a href="${escapeHtml(oauthUrl)}">Connect WhatsApp (coexistence)</a></p>
</body></html>`);
  });

  app.post("/connect/exchange", async (c) => {
    // Public-network reachable, but mutates the connected WABA/phone config (F4b):
    // gate it exactly like /v1/* in worker.ts before touching exchangeAndPersist.
    const cfg = getConfig(c.env);
    const authorizationHeader = c.req.header("authorization") ?? undefined;
    const apiKeyHeader = c.req.header("x-api-key") ?? undefined;
    if (!isAuthorized(authorizationHeader, apiKeyHeader, cfg.ECCOS_API_KEY)) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    let body: { code?: string; waba_id?: string; redirect_uri?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const { code, waba_id, redirect_uri } = body;
    if (!code) return c.json({ ok: false, error: "missing code" }, 400);
    const result = await exchangeAndPersist(c, code, waba_id, redirect_uri);
    return c.json(result, result.ok ? 200 : 502);
  });

  return app;
}
