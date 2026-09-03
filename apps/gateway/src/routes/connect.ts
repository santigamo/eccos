import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  exchangeCodeForToken,
  findWabaPhoneNumbersForToken,
  type PhoneNumber,
} from "../meta/connect-api";
import { authenticateRequest } from "../tenant-auth";
import { getAppConfig } from "../tenant-config";
import { getControlPlaneStub } from "../control-plane-stub";
import { kickWabaProvisioning } from "../provisioning";
import { constantTimeEqual } from "@eccos/core/signature";
import type {
  ConnectFailureCode,
  ConnectStartResult,
  ProvisioningStatus,
  WabaOnboardingType,
} from "@eccos/gateway-contract";

type ConnectContext = Context<{ Bindings: Env }>;

/** Cookie carrying the OAuth `state` for the GET /connect CSRF check (F4a). */
const STATE_COOKIE = "eccos_connect_state";
/**
 * Cookie carrying the console URL to return the operator to. It duplicates the
 * `return_to` on the connect state on purpose: the state row is single-use and
 * expires, and the one case that most needs a way home is precisely the one
 * where the state is gone (expired session, replayed callback). Re-validated on
 * read, so it can never widen the redirect target.
 */
const RETURN_COOKIE = "eccos_connect_return";
const STATE_COOKIE_MAX_AGE_SECONDS = 30 * 60;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * How long the callback waits for the WABAs it just registered to finish
 * provisioning before handing the operator back to the console (eccos-lpk).
 *
 * The exchange already costs three Meta round-trips, so one `subscribed_apps`
 * POST per WABA is a small addition and buys the thing that matters: the
 * console normally loads with the number already `active` instead of showing a
 * `pending` row for up to five minutes. The budget is the safety valve — a slow
 * or wedged Graph call must not hold the redirect, so past it the kick keeps
 * running under `waitUntil` and the console shows `pending` (with a re-check)
 * until it lands.
 */
const PROVISIONING_KICK_BUDGET_MS = 3_000;

/**
 * The Meta redirect back to /connect is a top-level GET navigation, so a
 * `SameSite=Lax` cookie is sent along with it while still blocking CSRF forms
 * (POST) and cross-site subresource requests.
 */
function setOAuthStateCookie(c: ConnectContext, state: string): void {
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: !LOCAL_HOSTNAMES.has(new URL(c.req.url).hostname.toLowerCase()),
    sameSite: "Lax",
    path: "/connect",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
}

function setReturnCookie(c: ConnectContext, returnTo: string | null): void {
  if (!returnTo) {
    deleteCookie(c, RETURN_COOKIE, { path: "/connect" });
    return;
  }
  setCookie(c, RETURN_COOKIE, returnTo, {
    httpOnly: true,
    secure: !LOCAL_HOSTNAMES.has(new URL(c.req.url).hostname.toLowerCase()),
    sameSite: "Lax",
    path: "/connect",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
}

function clearOAuthStateCookie(c: ConnectContext): void {
  deleteCookie(c, STATE_COOKIE, { path: "/connect" });
  deleteCookie(c, RETURN_COOKIE, { path: "/connect" });
}

function noStore(c: ConnectContext): void {
  c.header("Cache-Control", "no-store");
}

/** Constant-time comparison; missing query/cookie state always fails closed. */
export function oauthStateIsValid(queryState: string | null, cookieState: string | undefined): boolean {
  if (!queryState || !cookieState) return false;
  return constantTimeEqual(queryState, cookieState);
}

type ConnectedPhone = {
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
};

export type MultiExchangeResult =
  | {
      ok: true;
      waba_id: string;
      phone_number_id: string;
      display_phone_number: string;
      connected: ConnectedPhone[];
      status: ProvisioningStatus;
      warnings?: string[];
    }
  | { ok: false; error: string; code: ConnectFailureCode };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The two HTML surfaces the gateway still owns are seen by self-hosters, not by
 * console operators, so they stay deliberately plain — but plain is not the same
 * as unfinished, and this repo is public.
 */
function htmlDocument(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Eccos</title>
<style>
:root{color-scheme:light dark}
body{margin:0 auto;padding:3rem 1.5rem;max-width:44rem;line-height:1.6;
font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:1.5rem;margin:0 0 1rem}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.875rem}
pre{padding:1rem;overflow-x:auto;border-radius:.5rem;background:rgba(127,127,127,.12)}
</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body></html>`;
}

function resultPage(result: MultiExchangeResult): string {
  const title = result.ok ? "Provisioning started" : "Connect failed";
  return htmlDocument(title, `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`);
}

/**
 * The Facebook Login for Business dialog URL — the server-side half of Embedded
 * Signup, and every parameter on it is one Meta documents for the manual login
 * flow (`client_id`, `redirect_uri`, `state`, `response_type`) plus the
 * `config_id` that Login for Business adds.
 *
 * ── WHY THERE IS NO `extras` HERE ANY MORE ───────────────────────────────────
 * There used to be, carrying `featureType: "whatsapp_business_app_onboarding"`
 * to ask for the WhatsApp Business app (coexistence) flow. Two things were
 * wrong with it, and both were confirmed on 2026-09-01:
 *
 *  1. `extras` is not a parameter of `dialog/oauth`. Meta documents it only as
 *     an `FB.login()` option, and the dialog was observed to ignore it: the flow
 *     ran the ordinary Cloud API path, the WABA-selection screen was NOT
 *     replaced by the "connect your existing account" screen that is Meta's own
 *     test for the feature being on, and an existing coexistence number was not
 *     offered. Everything it asked for was silently dropped.
 *  2. Under Embedded Signup v4 there is nothing left for it to carry. Meta's v4
 *     extras object is "purposely empty": the flow's products and version come
 *     from the Facebook Login for Business configuration behind `config_id`,
 *     which this URL *can* carry, and `sessionInfoVersion` was a v2-only field
 *     (v3 and v4 return session info for every flow).
 *
 * So the version and the feature set now live entirely in `META_ES_CONFIG_ID`,
 * which is a v4 configuration created in the app panel. Nothing in this URL can
 * express them, and nothing here pretends to. The consequence worth knowing:
 * this code cannot tell a v4 configuration from a stale v2 one — a wrong id is
 * not detectable here, only downstream, where the coexistence verification in
 * `src/provisioning.ts` reads back what Meta actually did per number.
 */
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
  return `https://www.facebook.com/${cfg.META_GRAPH_VERSION ?? "v25.0"}/dialog/oauth?${params.toString()}`;
}

/**
 * What a browser gets when it opens `/connect` with nothing to go on: no state
 * capability in the URL, and no API key (a top-level navigation cannot carry an
 * `authorization` header, so this branch is never reachable *with* one).
 *
 * It is a signpost, not a step in the flow — it has no state to hand Meta, so it
 * cannot offer a link to the dialog even if it wanted to. The self-host entry
 * point it points at is `POST /connect/start`, which is the only way to mint the
 * one-time URL that a browser can then open.
 */
function connectEntryPage(startUrl: string): string {
  return htmlDocument(
    "Connect WhatsApp",
    `<p>This is the Meta Embedded Signup handoff for an Eccos gateway. It cannot be opened
directly: the link has to be created first, against a specific account.</p>
<p>In the operator console, use <strong>Connect WhatsApp</strong> — it creates the link and
follows it for you.</p>
<p>If you are self-hosting without a console, ask the gateway for a one-time link with your
account API key and open the <code>url</code> it returns in this browser:</p>
<pre>curl -X POST ${escapeHtml(startUrl)} \\
  -H "authorization: Bearer $ECCOS_ACCOUNT_API_KEY"</pre>
<p>The link is single-use and expires in 30 minutes.</p>`,
  );
}

/**
 * Build the console URL the operator is sent back to, re-validating the stored
 * target on every use: only absolute https (or http on localhost) with no
 * embedded credentials. A target that fails here yields null and the caller
 * falls back to the gateway's own result page, so a bad value degrades to the
 * old behaviour instead of redirecting anywhere unexpected.
 */
export function connectReturnUrl(
  returnTo: string | null | undefined,
  params: Record<string, string>,
): string | null {
  const value = returnTo?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = LOCAL_HOSTNAMES.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  for (const [key, param] of Object.entries(params)) url.searchParams.set(key, param);
  return url.href;
}

function callbackUrlForRedirectUri(redirectUri: string): string {
  return new URL("/webhooks/meta", redirectUri).href;
}

function connectConfig(c: ConnectContext) {
  return configuredConnect(c.env);
}

function configuredConnect(env: Env) {
  const cfg = getAppConfig(env);
  if (!cfg.META_APP_ID) throw new Error("META_APP_ID is required for /connect");
  if (!cfg.META_ES_CONFIG_ID) throw new Error("META_ES_CONFIG_ID is required for /connect");
  return cfg;
}

function isConnectConfigurationError(message: string): boolean {
  return message.startsWith("Invalid Eccos configuration:") || message.endsWith(" is required for /connect");
}

function validatePublicOrigin(value: string): string {
  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("public origin must be a valid URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error("public origin must use https");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error("public origin must contain only a scheme, host, and optional port");
  }
  return parsed.origin;
}

export async function startConnectForAccount(
  env: Env,
  accountId: string,
  publicOrigin: string,
  returnTo?: string,
): Promise<ConnectStartResult> {
  configuredConnect(env);
  const origin = validatePublicOrigin(publicOrigin);
  const redirectUri = new URL("/connect", origin).href;
  const state = crypto.randomUUID();
  const expiresAt = Date.now() + STATE_COOKIE_MAX_AGE_SECONDS * 1000;
  await getControlPlaneStub(env).startConnectState(state, accountId, expiresAt, redirectUri, returnTo);
  const url = new URL(redirectUri);
  url.searchParams.set("state", state);
  return { url: url.href, state, expiresAt };
}

function parseExchangeBody(value: unknown): { code: string; state?: string; waba_id?: string; redirect_uri?: string } | null {
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

/**
 * Hand a still-running kick to the runtime so it survives the response. Hono
 * throws when there is no ExecutionContext (a non-Workers host); the awaited
 * budget is then the only thing keeping it alive, which is no worse than the
 * cron-only behaviour it replaces.
 */
export type KeepAlive = (work: Promise<void>) => void;

function keepAlive(c: ConnectContext): KeepAlive {
  return (work) => {
    try {
      c.executionCtx.waitUntil(work);
    } catch {}
  };
}

/**
 * Provision the WABAs the callback just registered, bounded by
 * `PROVISIONING_KICK_BUDGET_MS`. Returns whatever settled inside the budget;
 * anything slower keeps running in the background and stays `pending` in the
 * answer, exactly as if only the cron had run. Never throws, so the operator's
 * way back to the console cannot depend on Meta answering.
 */
async function kickProvisioning(
  env: Env,
  keepRunning: KeepAlive,
  accountId: string,
  wabaIds: string[],
): Promise<Map<string, ProvisioningStatus>> {
  if (wabaIds.length === 0) return new Map();
  const kick = kickWabaProvisioning(env, accountId, wabaIds);
  keepRunning(kick.done);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      kick.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PROVISIONING_KICK_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return kick.statuses;
}

/**
 * Exchange an Embedded Signup code for a business token, then register
 * everything that token unlocks through {@link registerWabasForToken} — which
 * owns the discovery, the ownership policy, and the provisioning kick, and is
 * shared with the console's pasted-token path.
 *
 * The exchange is the only step that belongs to this function, and its own
 * failure is folded to `failed` here rather than inside the shared half: a code
 * that will not exchange never had a token to register.
 */
export async function exchangeAndRegisterAll(
  env: Env,
  keepRunning: KeepAlive,
  code: string,
  accountId: string,
  /**
   * The `redirect_uri` the code was minted against, and `undefined` when there
   * was none. Meta requires the exchange to repeat the value the dialog was
   * given — and requires it to be *absent* for a code that came from
   * `FB.login()`, which uses no redirect at all. Passing one there fails the
   * exchange, so this stays optional rather than defaulting to something
   * plausible.
   */
  redirectUri: string | undefined,
  /** Origin the per-WABA webhook callback URL is built from. */
  callbackOrigin: string,
  wabaSelector?: string,
): Promise<MultiExchangeResult> {
  let businessToken: string;
  try {
    businessToken = await exchangeCodeForToken(getAppConfig(env), code, redirectUri);
  } catch (e) {
    return { ok: false, error: errorMessage(e), code: "failed" };
  }
  return registerWabasForToken(env, keepRunning, {
    accountId,
    businessToken,
    callbackOrigin,
    ...(wabaSelector ? { wabaSelector } : {}),
    // `/connect` is the path that CAN produce a WhatsApp Business app
    // (coexistence) number — whether it does is decided by the Facebook Login
    // for Business configuration behind `META_ES_CONFIG_ID`, not by anything
    // this code can put in the dialog URL (see `oauthUrl`).
    //
    // So this is a claim, not a fact, and it is deliberately the *pessimistic*
    // one: recording `coexistence` is what makes the provisioning saga go and
    // ask Meta what the number actually is before it spends either once-only
    // sync (eccos-vss). Recording `standard` here would skip that question
    // entirely and silently strand a real coexistence customer with no history
    // sync. Every other registration path still defaults to `standard`, so an
    // omission can never invent an obligation.
    //
    // Registering it here is also what starts the 24-hour clock, at the moment
    // the handoff completed.
    onboardingType: "coexistence",
  });
}

/**
 * Register everything one Meta business token unlocks, under one account.
 *
 * The half of the connect flow that has nothing to do with OAuth: discover the
 * WABAs and phones the token can see, apply the ownership policy, write the
 * registrations, and provision them before answering. It is shared by both
 * entry points that hold such a token — the Embedded Signup exchange above and
 * the console's pasted-token form (eccos-up9) — so the ownership-conflict
 * policy exists in exactly ONE place: an explicit selector conflict fails
 * closed, an unrelated foreign match is skipped with a warning, and neither
 * entry point can drift into being the softer one.
 *
 * `onboardingType` is a required parameter rather than a default precisely
 * because the two callers must answer it differently and neither answer is
 * safe to inherit: see the comment at the `/connect` call site above, and the
 * rule it states — an omission must never invent a once-only sync obligation.
 *
 * `discovered` lets a caller that has already talked to Meta (the token path
 * inspects the token first, because it needs the verdict) pass what it found
 * instead of paying for the discovery round-trips twice.
 */
export async function registerWabasForToken(
  env: Env,
  keepRunning: KeepAlive,
  input: {
    accountId: string;
    /** The Meta token the registrations are sealed with. Never logged, never returned. */
    businessToken: string;
    /** Origin the per-WABA webhook callback URL is built from. */
    callbackOrigin: string;
    onboardingType: WabaOnboardingType;
    /**
     * Register only this WABA, and fail closed if the token cannot reach it.
     * The pasted-token path proves the selector against Meta itself and passes
     * it as the whole of `discovered`, so the "selector not discovered" guard
     * below only ever fires for the Embedded Signup path.
     */
    wabaSelector?: string;
    /** Discovery result, when the caller already has one. */
    discovered?: Array<{ wabaId: string; phones: PhoneNumber[] }>;
  },
): Promise<MultiExchangeResult> {
  const { accountId, businessToken, callbackOrigin, onboardingType, wabaSelector } = input;
  try {
    const appConfig = getAppConfig(env);
    const discovered =
      input.discovered ?? (await findWabaPhoneNumbersForToken(appConfig, businessToken));
    if (discovered.length === 0) {
      return { ok: false, error: "could not infer WABA from token", code: "no_waba" };
    }
    if (wabaSelector && !discovered.some((m) => m.wabaId === wabaSelector)) {
      return {
        ok: false,
        error: `waba "${wabaSelector}" is not owned by the initiating account`,
        code: "owned",
      };
    }
    const matches = wabaSelector ? discovered.filter((match) => match.wabaId === wabaSelector) : discovered;

    const callbackUrl = callbackUrlForRedirectUri(callbackOrigin);
    const controlPlane = getControlPlaneStub(env);
    const foreignWabaIds = new Set<string>();
    const warnings: string[] = [];

    for (const match of matches) {
      const owned = await controlPlane.getWabaById(match.wabaId);
      if (owned && owned.accountId !== accountId) {
        if (wabaSelector) {
          return {
            ok: false,
            error: `waba "${match.wabaId}" is already registered to another account`,
            code: "owned",
          };
        }
        foreignWabaIds.add(match.wabaId);
        warnings.push(`waba "${match.wabaId}" is already registered to another account and was skipped`);
      }
    }

    const availableMatches = matches.filter((match) => !foreignWabaIds.has(match.wabaId));
    if (availableMatches.length === 0) {
      return { ok: false, error: "no available WABA could be registered", code: "owned" };
    }

    const registrations = await controlPlane.beginWabaProvisioningBatch(
      availableMatches.map((match) => ({
        accountId,
        wabaId: match.wabaId,
        metaAccessToken: businessToken,
        callbackUrl,
        phones: match.phones.map((p) => ({
          phoneNumberId: p.id,
          displayPhoneNumber: p.display_phone_number ?? "",
        })),
        onboardingType,
      })),
    );

    const primary = availableMatches[0];
    if (!primary) return { ok: false, error: "WABA registration failed", code: "failed" };

    // The pending rows are durable now, so run provisioning here instead of
    // leaving it to the cron: this is the moment the operator is watching.
    const kicked = await kickProvisioning(
      env,
      keepRunning,
      accountId,
      registrations.map((registration) => registration.waba.wabaId),
    );
    const statuses = registrations.map(
      (registration) => kicked.get(registration.waba.wabaId) ?? registration.waba.status,
    );
    const status = statuses.includes("failed")
      ? "failed"
      : statuses.every((value) => value === "active")
        ? "active"
        : "pending";
    return {
      ok: true,
      waba_id: primary.wabaId,
      phone_number_id: primary.phones[0]?.id ?? "",
      display_phone_number: primary.phones[0]?.display_phone_number ?? "",
      status,
      connected: availableMatches.flatMap((m) =>
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
    return { ok: false, error: message, code: "failed" };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function connectRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/connect/start", async (c) => {
    noStore(c);
    const account = await authenticateRequest(
      c.env,
      c.req.header("authorization") ?? undefined,
      c.req.header("x-api-key") ?? undefined,
    );
    if (!account) return c.json({ ok: false, error: "unauthorized" }, 401);
    try {
      const result = await startConnectForAccount(c.env, account.accountId, new URL(c.req.url).origin);
      return c.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "connect is not configured";
      return c.json({ ok: false, error: message }, isConnectConfigurationError(message) ? 503 : 400);
    }
  });

  app.get("/connect", async (c) => {
    const url = new URL(c.req.url);
    noStore(c);
    let redirectUri = new URL("/connect", c.req.url).href;
    // Captured before clearOAuthStateCookie(): the way home has to survive the
    // paths where the OAuth state itself is gone.
    const returnCookie = getCookie(c, RETURN_COOKIE);

    /** Hand the operator back to the console, or fall back to the result page. */
    const finish = (
      returnTo: string | null | undefined,
      params: Record<string, string>,
      result: MultiExchangeResult,
      status: 200 | 202 | 400 | 502 | 503,
    ) => {
      const target = connectReturnUrl(returnTo, params);
      noStore(c);
      return target ? c.redirect(target, 303) : c.html(resultPage(result), status);
    };

    const code = url.searchParams.get("code");
    if (code) {
      const queryState = url.searchParams.get("state");
      const cookieState = getCookie(c, STATE_COOKIE);
      clearOAuthStateCookie(c);
      if (!oauthStateIsValid(queryState, cookieState)) {
        return finish(
          returnCookie,
          { connectError: "state" },
          { ok: false, error: "invalid or missing OAuth state", code: "state" },
          400,
        );
      }
      const stateRecord = await getControlPlaneStub(c.env).consumeConnectStateRecord(queryState ?? "");
      if (!stateRecord) {
        return finish(
          returnCookie,
          { connectError: "state" },
          { ok: false, error: "invalid or expired OAuth state", code: "state" },
          400,
        );
      }
      const exchangeRedirectUri = stateRecord.redirectUri ?? redirectUri;
      const result = await exchangeAndRegisterAll(
        c.env,
        keepAlive(c),
        code,
        stateRecord.accountId,
        exchangeRedirectUri,
        exchangeRedirectUri,
      );
      const returnTo = stateRecord.returnTo ?? returnCookie;
      if (!result.ok) {
        return finish(returnTo, { connectError: result.code }, result, 502);
      }
      // Success is quiet: the console shows the new numbers in its own table.
      // The only thing worth carrying is what was NOT connected.
      const skipped = result.warnings?.length ?? 0;
      return finish(
        returnTo,
        skipped > 0 ? { connectSkipped: String(skipped) } : {},
        result,
        result.status === "active" ? 200 : 202,
      );
    }

    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description") ?? error;
      clearOAuthStateCookie(c);
      return finish(
        returnCookie,
        { connectError: "denied" },
        { ok: false, error: description, code: "denied" },
        400,
      );
    }

    const handoffState = url.searchParams.get("state");
    let state = handoffState?.trim() || "";
    let returnTo: string | null = null;
    if (state) {
      const stateRecord = await getControlPlaneStub(c.env).refreshConnectState(
        state,
        Date.now() + STATE_COOKIE_MAX_AGE_SECONDS * 1000,
      );
      if (!stateRecord) {
        return finish(
          returnCookie,
          { connectError: "state" },
          { ok: false, error: "invalid or expired OAuth state", code: "state" },
          400,
        );
      }
      redirectUri = stateRecord.redirectUri ?? redirectUri;
      returnTo = stateRecord.returnTo;
    } else {
      const account = await authenticateRequest(
        c.env,
        c.req.header("authorization") ?? undefined,
        c.req.header("x-api-key") ?? undefined,
      );
      if (!account) {
        return c.html(connectEntryPage(new URL("/connect/start", c.req.url).href), 401);
      }
      state = crypto.randomUUID();
      await getControlPlaneStub(c.env).startConnectState(
        state,
        account.accountId,
        Date.now() + STATE_COOKIE_MAX_AGE_SECONDS * 1000,
        redirectUri,
      );
    }
    setOAuthStateCookie(c, state);
    setReturnCookie(c, returnTo);
    let cfg: ReturnType<typeof connectConfig>;
    try {
      cfg = connectConfig(c);
    } catch (error) {
      const message = error instanceof Error ? error.message : "connect is not configured";
      return finish(returnTo, { connectError: "failed" }, { ok: false, error: message, code: "failed" }, 503);
    }
    // Hand off to Meta in the same navigation. The cookies set just above ride
    // on this 302: `Set-Cookie` is stored from a redirect response like any
    // other, and this request is a *top-level* navigation to the gateway's own
    // origin, so they are first-party cookies, not the third-party kind a
    // browser would drop (eccos-7jk).
    //
    // Their `SameSite=Lax` still holds on Meta's way back: the callback arrives
    // as a cross-site top-level GET navigation, which is exactly the case Lax
    // allows through. That leg is unchanged — a click on an interstitial link
    // was also a cross-site top-level GET — so the mirror cookie keeps working
    // on the expired and replayed paths it was built for (eccos-5z9).
    //
    // What the interstitial did buy, and this does not, is a user interaction on
    // the gateway's own origin: both hops are now pure redirects, which is what
    // browser bounce-tracking mitigations look for. Harmless as long as nothing
    // here needs to outlive the flow — these cookies are 30-minute, single-use,
    // and the callback deletes them — so do not start storing anything durable
    // on this origin without rechecking that.
    return c.redirect(oauthUrl(cfg, redirectUri, state), 302);
  });

  app.post("/connect/exchange", async (c) => {
    noStore(c);
    // Public-network reachable, but mutates the connected WABA/phone config (F4b):
    // gate it before touching the exchange. Requires an account API key and
    // resolves the account from the control plane.
    const authorizationHeader = c.req.header("authorization") ?? undefined;
    const apiKeyHeader = c.req.header("x-api-key") ?? undefined;

    const account = await authenticateRequest(c.env, authorizationHeader, apiKeyHeader);
    if (!account) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    let body: ReturnType<typeof parseExchangeBody>;
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
    const expectedRedirectUri = new URL("/connect", c.req.url).href;
    if (redirect_uri !== undefined && redirect_uri !== expectedRedirectUri) {
      return c.json({ ok: false, error: "redirect_uri does not match the connect origin" }, 400);
    }
    const stateRecord = await controlPlane.getConnectState(state);
    if (!stateRecord || stateRecord.accountId !== account.accountId) {
      return c.json({ ok: false, error: "invalid or expired OAuth state" }, 400);
    }
    if (stateRecord.redirectUri && stateRecord.redirectUri !== expectedRedirectUri) {
      return c.json({ ok: false, error: "redirect_uri does not match the connect origin" }, 400);
    }
    const consumedState = await controlPlane.consumeConnectStateForAccount(state, account.accountId);
    if (!consumedState) {
      return c.json({ ok: false, error: "invalid or expired OAuth state" }, 400);
    }
    const exchangeRedirectUri = consumedState.redirectUri ?? expectedRedirectUri;
    const result = await exchangeAndRegisterAll(
      c.env,
      keepAlive(c),
      code,
      account.accountId,
      exchangeRedirectUri,
      exchangeRedirectUri,
      waba_id,
    );
    return c.json(result, result.ok ? 202 : 502);
  });

  return app;
}
