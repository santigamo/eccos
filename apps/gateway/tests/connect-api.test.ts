import { afterEach, describe, expect, it } from "bun:test";
import { extractTokenTargetIds } from "../src/meta/connect-api";
import { connectRoutes, extractApiKey, isAuthorized, oauthStateIsValid } from "../src/routes/connect";

describe("extractTokenTargetIds", () => {
  it("extracts unique WhatsApp granular scope targets", () => {
    expect(
      extractTokenTargetIds({
        data: {
          granular_scopes: [
            { scope: "public_profile", target_ids: ["ignored"] },
            { scope: "whatsapp_business_management", target_ids: ["waba-1", "waba-2"] },
            { scope: "whatsapp_business_messaging", target_ids: ["waba-1"] },
          ],
        },
      }),
    ).toEqual(["waba-1", "waba-2"]);
  });
});

// --- F4: /connect fail-closed (CSRF state + operator-only exchange) -------

const TEST_API_KEY = "test-operator-key";
const STATE_COOKIE_NAME = "eccos_connect_state";

/**
 * Minimal stand-in for the Cloudflare `Env` binding: only the fields
 * `getConfig`/`parseCoreConfig` read, plus a fake `ECCOS` Durable Object
 * namespace that records every `saveConfig` call so tests can assert a
 * rejected request never mutated the connected WABA/phone config.
 */
function makeEnv(saveConfigCalls: Record<string, string>[]) {
  return {
    META_GRAPH_VERSION: "v24.0",
    FORWARD_MAX_ATTEMPTS: "6",
    META_ACCESS_TOKEN: "token",
    META_PHONE_NUMBER_ID: "env-phone",
    META_WABA_ID: "env-waba",
    META_APP_SECRET: "app-secret",
    META_WEBHOOK_VERIFY_TOKEN: "verify-token",
    ECCOS_API_KEY: TEST_API_KEY,
    META_APP_ID: "app-id",
    META_ES_CONFIG_ID: "es-config-id",
    ECCOS: {
      idFromName: (name: string) => name,
      get: () => ({
        saveConfig: async (entries: Record<string, string>) => {
          saveConfigCalls.push(entries);
        },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function extractCookieValue(setCookieHeader: string | null, name: string): string {
  if (!setCookieHeader) throw new Error("expected a set-cookie header on the response");
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`cookie ${name} not present in set-cookie header: ${setCookieHeader}`);
  return match[1];
}

/** Mocks the three Graph API calls `exchangeAndPersist` makes for a successful connect. */
function mockMetaFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "biz-token" }), { status: 200 });
    }
    if (url.includes("/debug_token")) {
      return new Response(
        JSON.stringify({
          data: {
            granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA123"] }],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/phone_numbers")) {
      return new Response(
        JSON.stringify({ data: [{ id: "PNID", display_phone_number: "+34 600 000 000" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/subscribed_apps")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("oauthStateIsValid (F4a CSRF helper)", () => {
  it("rejects a missing query state", () => {
    expect(oauthStateIsValid(null, "cookie-state")).toBe(false);
  });

  it("rejects a missing cookie state", () => {
    expect(oauthStateIsValid("query-state", undefined)).toBe(false);
  });

  it("rejects a mismatched state", () => {
    expect(oauthStateIsValid("query-state", "other-state")).toBe(false);
  });

  it("accepts a matching state", () => {
    expect(oauthStateIsValid("same-state", "same-state")).toBe(true);
  });
});

describe("extractApiKey / isAuthorized (F4b operator-auth helper)", () => {
  it("returns undefined when neither header is present", () => {
    expect(extractApiKey(undefined, undefined)).toBeUndefined();
  });

  it("prefers the Bearer token over x-api-key", () => {
    expect(extractApiKey("Bearer from-bearer", "from-header")).toBe("from-bearer");
  });

  it("falls back to x-api-key when there is no Bearer prefix", () => {
    expect(extractApiKey(undefined, "from-header")).toBe("from-header");
  });

  it("rejects when no key is supplied", () => {
    expect(isAuthorized(undefined, undefined, TEST_API_KEY)).toBe(false);
  });

  it("rejects a wrong key from either header", () => {
    expect(isAuthorized(undefined, "wrong-key", TEST_API_KEY)).toBe(false);
    expect(isAuthorized("Bearer wrong-key", undefined, TEST_API_KEY)).toBe(false);
  });

  it("accepts the correct key via Bearer or x-api-key", () => {
    expect(isAuthorized(`Bearer ${TEST_API_KEY}`, undefined, TEST_API_KEY)).toBe(true);
    expect(isAuthorized(undefined, TEST_API_KEY, TEST_API_KEY)).toBe(true);
  });
});

describe("GET /connect OAuth state (F4a CSRF, route-level)", () => {
  it("sets an HttpOnly/Secure/SameSite=Lax state cookie scoped to /connect on render", async () => {
    const app = connectRoutes();
    const res = await app.request("http://localhost/connect", {}, makeEnv([]));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${STATE_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/connect");
  });

  it("rejects the callback when state is missing entirely (no config write)", async () => {
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const env = makeEnv(calls);
    const render = await app.request("http://localhost/connect", {}, env);
    const cookieValue = extractCookieValue(render.headers.get("set-cookie"), STATE_COOKIE_NAME);

    const res = await app.request(
      "http://localhost/connect?code=oauth-code",
      { headers: { Cookie: `${STATE_COOKIE_NAME}=${cookieValue}` } },
      env,
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects the callback when the state does not match the cookie (no config write)", async () => {
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const env = makeEnv(calls);
    const render = await app.request("http://localhost/connect", {}, env);
    const cookieValue = extractCookieValue(render.headers.get("set-cookie"), STATE_COOKIE_NAME);

    const res = await app.request(
      `http://localhost/connect?code=oauth-code&state=not-${cookieValue}`,
      { headers: { Cookie: `${STATE_COOKIE_NAME}=${cookieValue}` } },
      env,
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects the callback when there is no state cookie at all (no config write)", async () => {
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const res = await app.request(
      "http://localhost/connect?code=oauth-code&state=whatever",
      {},
      makeEnv(calls),
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("completes the happy path when the callback state matches the cookie", async () => {
    globalThis.fetch = mockMetaFetch();
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const env = makeEnv(calls);
    const render = await app.request("http://localhost/connect", {}, env);
    const cookieValue = extractCookieValue(render.headers.get("set-cookie"), STATE_COOKIE_NAME);

    const res = await app.request(
      `http://localhost/connect?code=oauth-code&state=${cookieValue}`,
      { headers: { Cookie: `${STATE_COOKIE_NAME}=${cookieValue}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ META_WABA_ID: "WABA123", META_PHONE_NUMBER_ID: "PNID" });
  });
});

describe("POST /connect/exchange operator auth (F4b, route-level)", () => {
  it("rejects with 401 when no Authorization/x-api-key header is present (no config write)", async () => {
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const res = await app.request(
      "http://localhost/connect/exchange",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "oauth-code", waba_id: "WABA123" }),
      },
      makeEnv(calls),
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("rejects with 401 when the API key is wrong (no config write)", async () => {
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const res = await app.request(
      "http://localhost/connect/exchange",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
        body: JSON.stringify({ code: "oauth-code", waba_id: "WABA123" }),
      },
      makeEnv(calls),
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("allows the exchange with a valid Bearer API key (happy path)", async () => {
    globalThis.fetch = mockMetaFetch();
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const res = await app.request(
      "http://localhost/connect/exchange",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_API_KEY}` },
        body: JSON.stringify({ code: "oauth-code", waba_id: "WABA123" }),
      },
      makeEnv(calls),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, waba_id: "WABA123", phone_number_id: "PNID" });
    expect(calls).toHaveLength(1);
  });

  it("also allows the exchange with a valid x-api-key header", async () => {
    globalThis.fetch = mockMetaFetch();
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const res = await app.request(
      "http://localhost/connect/exchange",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
        body: JSON.stringify({ code: "oauth-code", waba_id: "WABA123" }),
      },
      makeEnv(calls),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
