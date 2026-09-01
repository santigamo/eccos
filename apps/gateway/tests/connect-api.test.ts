import { afterEach, describe, expect, it } from "bun:test";
import {
  extractTokenTargetIds,
  findWabaPhoneNumbersForToken,
  getPhoneNumberOnboarding,
  listPhoneNumbers,
} from "../src/meta/connect-api";
import { connectRoutes, oauthStateIsValid } from "../src/routes/connect";

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

describe("listPhoneNumbers", () => {
  it("follows Meta pagination without putting the business token in the URL", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            data: [{ id: "PN_1", display_phone_number: "+34 600 000 001" }],
            paging: {
              next: "https://graph.facebook.com/v25.0/WABA/phone_numbers?after=cursor&access_token=secret-token",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [{ id: "PN_2" }] }), { status: 200 });
    }) as typeof fetch;

    await expect(
      listPhoneNumbers({ META_GRAPH_VERSION: "v25.0" }, "WABA", "secret-token"),
    ).resolves.toEqual([
      { id: "PN_1", display_phone_number: "+34 600 000 001" },
      { id: "PN_2" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).not.toContain("access_token");
    expect(requests[1]?.url).not.toContain("access_token");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
    expect(requests[1]?.init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
  });

  it("keeps the app secret out of the debug-token URL", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({ data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA"] }] } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [{ id: "PN" }] }), { status: 200 });
    }) as typeof fetch;

    await expect(
      findWabaPhoneNumbersForToken(
        { META_GRAPH_VERSION: "v25.0", META_APP_ID: "app-id", META_APP_SECRET: "app-secret" },
        "business-token",
      ),
    ).resolves.toEqual([{ wabaId: "WABA", phones: [{ id: "PN" }] }]);
    expect(requests[0]?.url).not.toContain("app-secret");
    expect(requests[0]?.url).not.toContain("access_token");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer app-id|app-secret" });
  });
});

/**
 * The read that turns Eccos's coexistence *assertion* into evidence
 * (eccos-vss, item 3). Everything downstream of it is once-only and
 * irreversible, so both the request shape and the parsing of a partial answer
 * matter.
 */
describe("getPhoneNumberOnboarding", () => {
  it("asks Meta for the two documented fields, on the phone number node", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ id: "PN_1", is_on_biz_app: true, platform_type: "CLOUD_API" }),
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(
      getPhoneNumberOnboarding({ META_GRAPH_VERSION: "v25.0" }, "PN_1", "biz-token"),
    ).resolves.toEqual({ isOnBizApp: true, platformType: "CLOUD_API" });

    const url = new URL(requests[0]?.url ?? "");
    // The node is the phone number, not the WABA.
    expect(url.pathname).toBe("/v25.0/PN_1");
    expect(url.searchParams.get("fields")).toBe("is_on_biz_app,platform_type");
    // The business token travels in the header, never in the URL.
    expect(url.searchParams.get("access_token")).toBeNull();
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer biz-token" });
  });

  it("reports a field Meta omitted as unknown rather than as false", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "PN_1" }), { status: 200 })) as typeof fetch;
    await expect(
      getPhoneNumberOnboarding({ META_GRAPH_VERSION: "v25.0" }, "PN_1", "biz-token"),
    ).resolves.toEqual({ isOnBizApp: null, platformType: null });
  });

  it("throws on a Graph error, so the caller retries instead of concluding", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), {
        status: 503,
      })) as typeof fetch;
    await expect(
      getPhoneNumberOnboarding({ META_GRAPH_VERSION: "v25.0" }, "PN_1", "biz-token"),
    ).rejects.toThrow(/phone_number onboarding failed: 503/);
  });
});

// --- F4: /connect fail-closed (CSRF state + account-bound exchange) -------

const STATE_COOKIE_NAME = "eccos_connect_state";

/**
 * Minimal stand-in for the Cloudflare `Env` binding: only the fields
 * `getAppConfig`/the connect auth read, plus a fake control-plane stub that
 * records the state/OAuth mutations and a fake `ECCOS` namespace that records
 * `saveConfig` calls so tests can assert a rejected request never mutated the
 * connected WABA/phone config.
 */
function makeEnv(saveConfigCalls: Record<string, string>[], accountId = "acc-test") {
  return {
    META_GRAPH_VERSION: "v25.0",
    META_APP_SECRET: "app-secret",
    META_WEBHOOK_VERIFY_TOKEN: "verify-token",
    META_APP_ID: "app-id",
    META_ES_CONFIG_ID: "es-config-id",
    CONTROL_PLANE: {
      idFromName: (name: string) => name,
      get: () => ({
        authenticateApiKey: async (raw: string) =>
          raw === "account-key" ? { accountId, keyId: "key_1" } : null,
        startConnectState: async (state: string, id: string, expiresAt: number) => {
          void state;
          void id;
          void expiresAt;
        },
        getConnectStateAccount: async (state: string) => (state === "valid-state" ? accountId : null),
        getConnectState: async (state: string) =>
          state === "valid-state" ? { accountId, redirectUri: null } : null,
        consumeConnectState: async (state: string) => (state === "valid-state" ? accountId : null),
        consumeConnectStateForAccount: async (state: string) =>
          state === "valid-state" ? { accountId, redirectUri: null } : null,
        consumeConnectStateRecord: async (state: string) =>
          state === "valid-state" ? { accountId, redirectUri: null } : null,
        beginWabaProvisioningBatch: async (inputs: unknown[]) => {
          const first = inputs[0] as { wabaId: string; phones: Array<{ phoneNumberId: string }> };
          return [{
            waba: {
              accountId,
              wabaId: first.wabaId,
              callbackUrl: null,
              createdAt: 1,
              status: "pending",
              provisioningError: null,
              phones: first.phones.map((p) => ({ phoneNumberId: p.phoneNumberId })),
            },
            phones: first.phones.map((p) => ({ phoneNumberId: p.phoneNumberId })),
          }];
        },
        getWabaById: async () => null,
      }),
    },
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

/** Mocks the three Graph API calls the account-bound exchange makes on success. */
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

describe("GET /connect OAuth state (F4a CSRF, route-level)", () => {
  it("requires an account API key for a fresh handoff", async () => {
    const app = connectRoutes();
    const res = await app.request("http://localhost/connect", {}, makeEnv([]));
    expect(res.status).toBe(401);
    const body = await res.text();
    // Not a dead end and not developer shorthand: the page names the one entry
    // point a self-hoster can actually use from here (eccos-7jk).
    expect(body).toContain("http://localhost/connect/start");
    expect(body).toContain("ECCOS_ACCOUNT_API_KEY");
    // Nothing to click through to Meta: this branch has no state to hand it.
    expect(body).not.toContain("facebook.com");
    expect(body).not.toContain("Manual OAuth flow");
  });

  it("sets an HttpOnly/Secure/SameSite=Lax state cookie on a public HTTPS origin", async () => {
    const app = connectRoutes();
    const res = await app.request(
      "https://gateway.example/connect",
      { headers: { authorization: "Bearer account-key" } },
      makeEnv([]),
    );
    // The cookie rides out on the redirect to Meta, not on an interstitial.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://www.facebook.com/");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${STATE_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/connect");
    expect(setCookie).toContain("Max-Age=1800");
  });

  it("omits Secure for a localhost HTTP development origin", async () => {
    const app = connectRoutes();
    const res = await app.request(
      "http://localhost/connect",
      { headers: { authorization: "Bearer account-key" } },
      makeEnv([]),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("keeps the redirect to Meta uncacheable and body-free", async () => {
    // A cached handoff would replay a spent state at Meta; a body would be a
    // place for the state to leak into.
    const app = connectRoutes();
    const res = await app.request(
      "https://gateway.example/connect",
      { headers: { authorization: "Bearer account-key" } },
      makeEnv([]),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
    const state = extractCookieValue(res.headers.get("set-cookie"), STATE_COOKIE_NAME);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("redirect_uri")).toBe("https://gateway.example/connect");
    expect(location.searchParams.get("client_id")).toBe("app-id");
    expect(location.searchParams.get("config_id")).toBe("es-config-id");
  });

  it("rejects the callback when state is missing entirely (no config write)", async () => {
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const env = makeEnv(calls);
    const render = await app.request(
      "http://localhost/connect",
      { headers: { authorization: "Bearer account-key" } },
      env,
    );
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
    const render = await app.request(
      "http://localhost/connect",
      { headers: { authorization: "Bearer account-key" } },
      env,
    );
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
});

describe("POST /connect/exchange (account-bound, F4b)", () => {
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

  it("rejects with 401 when the account key is unknown (no config write)", async () => {
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

  it("returns 400 for a malformed JSON body with valid auth (no config write)", async () => {
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const res = await app.request(
      "http://localhost/connect/exchange",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer account-key" },
        body: "{ not valid json",
      },
      makeEnv(calls),
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects 400 when no account-bound OAuth state is provided", async () => {
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const res = await app.request(
      "http://localhost/connect/exchange",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer account-key" },
        body: JSON.stringify({ code: "oauth-code", waba_id: "WABA123" }),
      },
      makeEnv(calls),
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("completes the exchange with a valid account key + account-bound state", async () => {
    globalThis.fetch = mockMetaFetch();
    const app = connectRoutes();
    const calls: Record<string, string>[] = [];
    const res = await app.request(
      "http://localhost/connect/exchange",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer account-key" },
        body: JSON.stringify({ code: "oauth-code", state: "valid-state", waba_id: "WABA123" }),
      },
      makeEnv(calls),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, waba_id: "WABA123", phone_number_id: "PNID", status: "pending" });
    // The account-bound exchange provisions through the control plane
    // (beginWabaProvisioningBatch), so it must not write the data-plane
    // ECCOS config — no saveConfig call is expected.
    expect(calls).toHaveLength(0);
  });
});
