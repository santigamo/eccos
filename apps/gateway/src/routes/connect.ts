import { Hono, type Context } from "hono";
import { getConfig } from "../config";
import { exchangeCodeForToken, findWabaPhoneNumbers, listPhoneNumbers, subscribeApp } from "../meta/connect-api";

type ConnectContext = Context<{ Bindings: Env }>;

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
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "code",
      config_id: configId,
      override_default_response_type: "true",
      state: crypto.randomUUID(),
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
    const { code, waba_id, redirect_uri } = await c.req.json<{
      code?: string;
      waba_id?: string;
      redirect_uri?: string;
    }>();
    if (!code) return c.json({ ok: false, error: "missing code" }, 400);
    const result = await exchangeAndPersist(c, code, waba_id, redirect_uri);
    return c.json(result, result.ok ? 200 : 502);
  });

  return app;
}
