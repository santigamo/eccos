import { env, exports } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";

/**
 * eccos-5z9: Embedded Signup has to hand the operator back to the console.
 *
 * The gateway owns Meta's callback, so without a return target the flow ends on
 * the gateway's own result page and the operator is stranded outside the app.
 * These tests pin the whole round trip: the console's return URL travels on the
 * connect state, survives the paths where that state is gone, and never widens
 * into an open redirect.
 */

const CONSOLE_RETURN = "https://app.eccos.chat/numbers";

type GraphWaba = { wabaId: string; phones: Array<{ id: string; display_phone_number?: string }> };

function mockGraph(
  wabas: GraphWaba[] = [{ wabaId: "WABA_RETURN", phones: [{ id: "PN_RETURN", display_phone_number: "+34 600 000 111" }] }],
): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "business-token" }), { status: 200 });
    }
    if (url.includes("/debug_token")) {
      return new Response(
        JSON.stringify({
          data: {
            granular_scopes: [
              { scope: "whatsapp_business_management", target_ids: wabas.map((w) => w.wabaId) },
            ],
          },
        }),
        { status: 200 },
      );
    }
    const waba = wabas.find((candidate) => url.includes(`/${candidate.wabaId}/phone_numbers`));
    if (waba) return new Response(JSON.stringify({ data: waba.phones }), { status: 200 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
}

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

let accountId = "";

/** The dashboard's own path: an organization-linked account, started over RPC. */
async function startFromConsole(returnTo?: string) {
  const rpc = new GatewayRPC(createExecutionContext(), env);
  const { url, state } = await rpc.startConnectForAccountId(accountId, returnTo);
  // The handoff is the redirect to Meta itself (eccos-7jk); the cookies the
  // callback needs are set on that redirect response.
  const handoff = await exports.default.fetch(url, { redirect: "manual" });
  expect(handoff.status).toBe(302);
  const cookies = handoff.headers.getSetCookie().join("; ");
  return { state, cookies, handoff };
}

/** Parse one `Set-Cookie` off a response, attributes included. */
function setCookie(res: Response, name: string): string {
  const found = res.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!found) {
    throw new Error(`no ${name} cookie in: ${JSON.stringify(res.headers.getSetCookie())}`);
  }
  return found;
}

function callback(query: string, cookies: string) {
  return exports.default.fetch(`https://gateway.example/connect?${query}`, {
    headers: { cookie: cookies },
    redirect: "manual",
  });
}

beforeEach(async () => {
  const rpc = new GatewayRPC(createExecutionContext(), env);
  const ensured = await rpc.ensureOrganizationAccount("org_return", "Return workspace");
  accountId = ensured.accountId;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/**
 * eccos-7jk: the departure. Pressing Connect WhatsApp used to land the operator
 * on an unstyled gateway page that asked for a second click to reach Meta. The
 * page is gone, but the cookies it set are load-bearing — everything below the
 * first test exists to prove the redirect did not take them with it.
 */
describe("Embedded Signup hands off to Meta in one navigation", () => {
  it("redirects to Meta's dialog with both cookies on the redirect response", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const { url, state } = await rpc.startConnectForAccountId(accountId, CONSOLE_RETURN);

    const res = await exports.default.fetch(url, { redirect: "manual" });

    // No interstitial: the operator's click reaches Meta, not a page about Meta.
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://www.facebook.com");
    expect(location.pathname).toMatch(/\/dialog\/oauth$/);
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("redirect_uri")).toBe("https://gateway.example/connect");
    expect(location.searchParams.get("response_type")).toBe("code");

    // A redirect carries Set-Cookie like any other response. Both cookies the
    // callback depends on have to be here, or the way home is gone.
    const stateCookie = setCookie(res, "eccos_connect_state");
    expect(stateCookie).toContain(`eccos_connect_state=${state}`);
    const returnCookie = setCookie(res, "eccos_connect_return");
    expect(returnCookie).toContain(encodeURIComponent(CONSOLE_RETURN));
    for (const cookie of [stateCookie, returnCookie]) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      // Lax, not Strict: Meta's callback is a cross-site top-level GET
      // navigation, and Strict would withhold the cookie on exactly that hop.
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/connect");
      expect(cookie).toContain("Max-Age=1800");
    }
    // A cached redirect would replay a spent state at Meta.
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Nothing to read: the response has no body to leak the state into.
    expect(await res.text()).toBe("");
  });

  it("still redirects, and clears the mirror cookie, when no console asked for a way back", async () => {
    // No console asked for a return, so the mirror cookie is actively cleared
    // rather than left pointing at whatever the last flow used.
    const { handoff } = await startFromConsole();

    expect(handoff.status).toBe(302);
    expect(handoff.headers.get("location")).toContain("facebook.com");
    expect(setCookie(handoff, "eccos_connect_return")).toContain("Max-Age=0");
  });
});

describe("Embedded Signup returns the operator to the console", () => {
  it("redirects to the console return URL on success, with no outcome params", async () => {
    mockGraph();
    const { state, cookies } = await startFromConsole(CONSOLE_RETURN);

    const res = await callback(`code=oauth-code&state=${encodeURIComponent(state)}`, cookies);

    expect(res.status).toBe(303);
    // Success is silent: the console shows the new number in its own table.
    expect(res.headers.get("location")).toBe(CONSOLE_RETURN);
    await cp(async (i) => {
      expect(await i.getWabaRecord(accountId, "WABA_RETURN")).toMatchObject({ accountId });
    });
  });

  it("carries a failure code instead of a Graph error message", async () => {
    // A token that sees no WABA at all: the operator needs to know why, but the
    // raw Graph payload has no business in a URL.
    mockGraph([]);
    const { state, cookies } = await startFromConsole(CONSOLE_RETURN);

    const res = await callback(`code=oauth-code&state=${encodeURIComponent(state)}`, cookies);

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(CONSOLE_RETURN);
    expect(location.searchParams.get("connectError")).toBe("no_waba");
  });

  it("reports WABAs skipped because another account already owns them", async () => {
    mockGraph([
      { wabaId: "WABA_RETURN", phones: [{ id: "PN_RETURN" }] },
      { wabaId: "WABA_FOREIGN", phones: [{ id: "PN_FOREIGN" }] },
    ]);
    await cp(async (i) => {
      const other = await i.createAccount({ accountId: "acc-return-foreign" });
      await i.registerWaba({
        accountId: other.account.accountId,
        wabaId: "WABA_FOREIGN",
        metaAccessToken: "other-token",
        provisioningStatus: "active",
        phones: [{ phoneNumberId: "PN_FOREIGN" }],
      });
    });
    const { state, cookies } = await startFromConsole(CONSOLE_RETURN);

    const res = await callback(`code=oauth-code&state=${encodeURIComponent(state)}`, cookies);

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("connectSkipped")).toBe("1");
    expect(location.searchParams.get("connectError")).toBeNull();
  });

  it("sends the operator home when Meta ends the flow without a code", async () => {
    mockGraph();
    const { cookies } = await startFromConsole(CONSOLE_RETURN);

    const res = await callback("error=access_denied&error_description=User+denied", cookies);

    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("connectError")).toBe("denied");
  });

  it("still finds the way home when the connect state is already gone", async () => {
    // The case the bug hit hardest: an expired or replayed callback has no state
    // row left to read a return URL from, so the return cookie is what keeps the
    // operator out of the gateway's result page.
    mockGraph();
    const { state, cookies } = await startFromConsole(CONSOLE_RETURN);
    const first = await callback(`code=oauth-code&state=${encodeURIComponent(state)}`, cookies);
    expect(first.status).toBe(303);

    const replay = await callback(`code=oauth-code&state=${encodeURIComponent(state)}`, cookies);

    expect(replay.status).toBe(303);
    expect(new URL(replay.headers.get("location") ?? "").searchParams.get("connectError")).toBe("state");
  });

  it("finds the way home on the mirror cookie alone when the state cookie expired", async () => {
    // The expiry case, isolated: the operator sat on Meta's dialog past the
    // 30-minute state cookie, so only the return cookie survives to the
    // callback. Nothing else in the request can say where the console is.
    mockGraph();
    const { state, handoff } = await startFromConsole(CONSOLE_RETURN);
    const returnOnly = setCookie(handoff, "eccos_connect_return").split(";")[0] ?? "";
    expect(returnOnly).not.toContain("eccos_connect_state");

    const res = await callback(`code=oauth-code&state=${encodeURIComponent(state)}`, returnOnly);

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(CONSOLE_RETURN);
    expect(location.searchParams.get("connectError")).toBe("state");
  });

  it("keeps the gateway's own result page when no console asked for a return", async () => {
    mockGraph();
    const { state, cookies } = await startFromConsole();

    const res = await callback(`code=oauth-code&state=${encodeURIComponent(state)}`, cookies);

    // 200, not 202: the callback provisions before it answers (eccos-lpk).
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("WABA_RETURN");
  });

  it("refuses a return target that is not an https console origin", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    await expect(
      rpc.startConnectForAccountId(accountId, "http://evil.example/steal"),
    ).rejects.toThrow(/returnTo/);
    await expect(
      rpc.startConnectForAccountId(accountId, "javascript:alert(1)"),
    ).rejects.toThrow(/returnTo/);
  });
});
