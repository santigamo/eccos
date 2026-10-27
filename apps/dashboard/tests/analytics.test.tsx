import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * eccos-mlq0.2 — the console's opt-in Umami integration: off without config,
 * a hashed identity, and a before-send hook that only lets utm_* through.
 */

const env: Record<string, string> = {};
installServerFnMocks({ env });

const { getAnalyticsConfig, hashUserId } = await import("../src/server/analytics");
const { AnalyticsScripts } = await import("../src/components/analytics");
const { analyticsBootstrapScript, BEFORE_SEND_HOOK, installAnalyticsHooks, track, trackSessionEvent } =
  await import("../src/lib/analytics");

const CONFIG = {
  scriptUrl: "https://analytics.example/script.js",
  websiteId: "website-1",
  domains: "app.eccos.chat",
  userId: "7a4df959ecd30899",
};

describe("server config (opt-in)", () => {
  beforeEach(() => {
    for (const key of Object.keys(env)) delete env[key];
    env.BETTER_AUTH_URL = "http://localhost:3000";
  });

  test("without both vars, analytics is off", async () => {
    expect(await getAnalyticsConfig()).toBeNull();
    env.ANALYTICS_SCRIPT_URL = CONFIG.scriptUrl;
    expect(await getAnalyticsConfig()).toBeNull();
  });

  test("an anonymous visitor gets the tracker, no identity, the default domain", async () => {
    env.ANALYTICS_SCRIPT_URL = ` ${CONFIG.scriptUrl} `;
    env.ANALYTICS_WEBSITE_ID = CONFIG.websiteId;
    expect(await getAnalyticsConfig()).toEqual({ ...CONFIG, userId: null });
  });

  test("the user id is a deterministic 16-char hex digest, never the raw id", async () => {
    const id = await hashUserId("user-123");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashUserId("user-123")).toBe(id);
    expect(await hashUserId("user-124")).not.toBe(id);
    expect(id).not.toContain("user-123");
  });
});

describe("document tags", () => {
  test("no config renders nothing", () => {
    expect(renderToStaticMarkup(<AnalyticsScripts analytics={null} />)).toBe("");
  });

  test("config renders the hook before the deferred tracker", () => {
    const html = renderToStaticMarkup(<AnalyticsScripts analytics={CONFIG} />);
    expect(html).toContain('data-website-id="website-1"');
    expect(html).toContain('data-domains="app.eccos.chat"');
    expect(html).toContain('data-do-not-track="true"');
    expect(html).toContain(`data-before-send="${BEFORE_SEND_HOOK}"`);
    expect(html.indexOf(BEFORE_SEND_HOOK)).toBeLessThan(html.indexOf("defer"));
  });
});

/** A stubbed browser for the hooks. */
function fakeWindow(search = "", stored?: string) {
  const store = new Map<string, string>(stored ? [["umami.disabled", stored]] : []);
  return {
    store,
    win: {
      location: { search, href: "https://app.eccos.chat/numbers" },
      localStorage: {
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    } as unknown as Window & Record<string, unknown>,
  };
}

describe("analytics hooks", () => {
  test("?nostats sets the tracker's own flag; ?nostats=0 clears it", () => {
    const flag = (search: string, stored?: string) => {
      const { win, store } = fakeWindow(search, stored);
      installAnalyticsHooks(win, BEFORE_SEND_HOOK);
      return store.get("umami.disabled");
    };
    expect(flag("?nostats")).toBe("1");
    expect(flag("?wabaId=w&nostats")).toBe("1");
    expect(flag("?nostats=0", "1")).toBeUndefined();
    expect(flag("?nostats=false", "1")).toBeUndefined();
    expect(flag("?stats")).toBeUndefined();
  });

  test("before-send keeps only utm_* on the url and the referrer", () => {
    const { win } = fakeWindow();
    installAnalyticsHooks(win, BEFORE_SEND_HOOK);
    const beforeSend = win[BEFORE_SEND_HOOK] as (type: string, payload: unknown) => unknown;

    expect(
      beforeSend("pageview", {
        url: "https://app.eccos.chat/numbers?state=s&code=c&UTM_Source=landing&page=2#x",
        referrer: "/reset-password?token=t&utm_medium=mail",
        title: "Numbers",
      }),
    ).toEqual({
      url: "https://app.eccos.chat/numbers?UTM_Source=landing#x",
      referrer: "/reset-password?utm_medium=mail",
      title: "Numbers",
    });
    expect(beforeSend("pageview", { url: "/x", referrer: "" })).toEqual({ url: "/x", referrer: "" });
    expect(beforeSend("pageview", null)).toBeNull();
  });

  test("the inline script is the same function, self-contained", () => {
    const { win, store } = fakeWindow("?nostats");
    new Function("window", analyticsBootstrapScript())(win);
    expect(store.get("umami.disabled")).toBe("1");
    expect(typeof win[BEFORE_SEND_HOOK]).toBe("function");
  });
});

test("tracking helpers are silent no-ops without a tracker", () => {
  expect(() => track("signup_submit")).not.toThrow();
  expect(() => track("connect_choice", { path: "new-number" })).not.toThrow();
  expect(() => trackSessionEvent({ event: "FINISH" })).not.toThrow();
  expect(() => trackSessionEvent({ event: "CANCEL", currentStep: "PHONE_NUMBER" })).not.toThrow();
  expect(() => trackSessionEvent({ event: "ERROR", errorCode: "132000" })).not.toThrow();
});
