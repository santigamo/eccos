import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsScripts } from "../src/components/analytics";
import {
  ANALYTICS_BEFORE_SEND,
  analyticsBootstrapScript,
  analyticsConfigFromEnv,
  analyticsUserId,
  DEFAULT_ANALYTICS_DOMAINS,
  isAnalyticsExcluded,
  parseExcludeUserIds,
  redactTrackedUrl,
  sanitizeAnalyticsPayload,
  track,
  trackSessionEvent,
  type AnalyticsClientConfig,
} from "../src/lib/analytics";

/**
 * eccos-mlq0.2 — the pure half of the console's Umami integration.
 *
 * What is asserted here is the part a browser cannot prove: that analytics is
 * OFF without config, that the analytics id is a salted hash, and that a URL
 * loses its stateful/secret parameters while keeping the landing's `utm_*`
 * attribution. The rendering test renders the real component rather than a
 * mirror of its markup, so "no config ⇒ no script" cannot drift.
 */

const ENABLED = {
  ANALYTICS_SCRIPT_URL: "https://analytics.example/script.js",
  ANALYTICS_WEBSITE_ID: "website-1",
};

const CLIENT_CONFIG: AnalyticsClientConfig = {
  scriptUrl: "https://analytics.example/script.js",
  websiteId: "website-1",
  domains: "app.eccos.chat",
  user: { id: "7a4df959ecd30899", role: "admin", hasOrg: true },
};

describe("analytics config (opt-in)", () => {
  test("with no vars, or half a pair, analytics is off", () => {
    expect(analyticsConfigFromEnv({})).toBeNull();
    expect(analyticsConfigFromEnv({ ANALYTICS_SCRIPT_URL: "  " })).toBeNull();
    expect(analyticsConfigFromEnv({ ANALYTICS_WEBSITE_ID: "website-1" })).toBeNull();
    expect(
      analyticsConfigFromEnv({ ...ENABLED, ANALYTICS_WEBSITE_ID: "   " }),
    ).toBeNull();
  });

  test("the production pair defaults the domain list to the console host", () => {
    const config = analyticsConfigFromEnv(ENABLED);
    expect(config).not.toBeNull();
    expect(config?.scriptUrl).toBe("https://analytics.example/script.js");
    expect(config?.websiteId).toBe("website-1");
    expect(config?.domains).toBe(DEFAULT_ANALYTICS_DOMAINS);
    expect(config?.excludeUserIds.size).toBe(0);
  });

  test("domains and the exclusion list are trimmed", () => {
    const config = analyticsConfigFromEnv({
      ...ENABLED,
      ANALYTICS_DOMAINS: " localhost ",
      ANALYTICS_EXCLUDE_USER_IDS: " owner-1, owner-2 ",
    });
    expect(config?.domains).toBe("localhost");
    expect([...(config?.excludeUserIds ?? [])]).toEqual(["owner-1", "owner-2"]);
    expect(config && isAnalyticsExcluded(config, "owner-1")).toBe(true);
    expect(config && isAnalyticsExcluded(config, "someone-else")).toBe(false);
  });

  test("the exclusion list tolerates blanks and duplicates", () => {
    expect([...parseExcludeUserIds(" a, b ,,a, ")]).toEqual(["a", "b"]);
    expect(parseExcludeUserIds(undefined).size).toBe(0);
    expect(parseExcludeUserIds(" , ").size).toBe(0);
  });
});

describe("analytics user id", () => {
  test("is a deterministic, 16-character hex digest", async () => {
    const first = await analyticsUserId("user-1");
    expect(first).toBe(await analyticsUserId("user-1"));
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    // Pinned: sha256("eccos:user-1"), first 16 characters. A change here means
    // the salt (or the truncation) moved, and every existing Umami identity
    // with it.
    expect(first).toBe("7a4df959ecd30899");
  });

  test("is salted, so it is not the raw id", async () => {
    const id = await analyticsUserId("user-1");
    expect(id).not.toContain("user-1");
    expect(id).not.toBe("user-1");
    expect(await analyticsUserId("user-2")).not.toBe(id);
  });
});

describe("tracked URL redaction", () => {
  test("keeps utm_* and benign params, drops state and secrets", () => {
    const url =
      "/numbers?state=oauth-state&code=abc123&connectError=owned&connectSkipped=2" +
      "&redirect=%2Fsettings&token=t&invitation=inv-1&wabaId=waba-1&email=a%40b.c" +
      "&utm_source=landing&utm_campaign=launch&page=2";
    expect(redactTrackedUrl(url)).toBe(
      "/numbers?utm_source=landing&utm_campaign=launch&page=2",
    );
  });

  test("keeps an absolute URL absolute", () => {
    expect(
      redactTrackedUrl("https://app.eccos.chat/events?event=77&state=x&utm_medium=email"),
    ).toBe("https://app.eccos.chat/events?event=77&utm_medium=email");
  });

  test("matches parameter names case-insensitively but never touches utm_", () => {
    expect(redactTrackedUrl("/x?State=1&UTM_Source=news&Token=t")).toBe(
      "/x?UTM_Source=news",
    );
  });

  test("a URL it cannot parse is returned untouched, not thrown on", () => {
    expect(redactTrackedUrl("http://[")).toBe("http://[");
  });

  test("the invitation being accepted is not tracked", () => {
    expect(redactTrackedUrl("/invitations?id=inv-1&utm_source=mail")).toBe(
      "/invitations?utm_source=mail",
    );
  });

  test("sanitizing a payload redacts its url and referrer, nothing else", () => {
    expect(
      sanitizeAnalyticsPayload({
        url: "/numbers?code=x&utm_source=a",
        referrer: "/numbers?state=s&connectError=owned",
        title: "Numbers",
      }),
    ).toEqual({ url: "/numbers?utm_source=a", referrer: "/numbers", title: "Numbers" });
    expect(sanitizeAnalyticsPayload({ title: "no url" })).toEqual({ title: "no url" });
    expect(sanitizeAnalyticsPayload("plain")).toBe("plain");
  });
});

describe("document tags (the opt-in rendering decision)", () => {
  test("no config renders no script and no hook", () => {
    expect(renderToStaticMarkup(<AnalyticsScripts analytics={null} />)).toBe("");
  });

  test("config renders the deferred tracker with the console's attributes", () => {
    const html = renderToStaticMarkup(<AnalyticsScripts analytics={CLIENT_CONFIG} />);
    expect(html).toContain('src="https://analytics.example/script.js"');
    expect(html).toContain("defer");
    expect(html).toContain('data-website-id="website-1"');
    expect(html).toContain('data-domains="app.eccos.chat"');
    expect(html).toContain('data-do-not-track="true"');
    expect(html).toContain(`data-before-send="${ANALYTICS_BEFORE_SEND}"`);
  });

  test("the inline bootstrap runs before the deferred tracker", () => {
    const html = renderToStaticMarkup(<AnalyticsScripts analytics={CLIENT_CONFIG} />);
    const bootstrap = html.indexOf("umami.disabled");
    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(html.indexOf('src="https://analytics.example/script.js"'));
  });

  test("the bootstrap carries the owner opt-out and the redaction hook", () => {
    const script = analyticsBootstrapScript();
    expect(script).toContain("nostats");
    expect(script).toContain("umami.disabled");
    expect(script).toContain(`window.${ANALYTICS_BEFORE_SEND}`);
    for (const key of ["state", "code", "connecterror", "connectskipped", "wabaid"]) {
      expect(script).toContain(`"${key}":1`);
    }
  });
});

describe("the inline bootstrap actually runs", () => {
  /** Executes the generated script against a stubbed browser. */
  function runBootstrap(search: string, stored: string | null = null) {
    const store = new Map<string, string>();
    if (stored !== null) store.set("umami.disabled", stored);
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    };
    const location = {
      search,
      href: "https://app.eccos.chat/numbers?state=secret&utm_source=landing",
    };
    const window: Record<string, unknown> = {};
    // The script is generated from module constants — no request or user value
    // is in it — and this is the only way to test the copy the browser runs.
    const run = new Function("location", "localStorage", "console", "window", analyticsBootstrapScript());
    run(location, localStorage, { info: () => {} }, window);
    return { store, window };
  }

  test("?nostats sets the tracker's own flag; ?nostats=0 clears it", () => {
    expect(runBootstrap("?nostats").store.get("umami.disabled")).toBe("1");
    expect(runBootstrap("?wabaId=w&nostats").store.get("umami.disabled")).toBe("1");
    expect(runBootstrap("?nostats=0", "1").store.get("umami.disabled")).toBeUndefined();
    expect(runBootstrap("?nostats=false", "1").store.get("umami.disabled")).toBeUndefined();
    expect(runBootstrap("?stats").store.get("umami.disabled")).toBeUndefined();
  });

  test("the before-send hook redacts without touching the address bar", () => {
    const { window } = runBootstrap("");
    const beforeSend = window[ANALYTICS_BEFORE_SEND] as (
      type: string,
      payload: unknown,
    ) => { url?: string };
    expect(
      beforeSend("pageview", {
        url: "https://app.eccos.chat/numbers?state=s&code=c&connectError=owned&utm_source=landing&page=2",
      }).url,
    ).toBe("https://app.eccos.chat/numbers?utm_source=landing&page=2");
    // Umami reports the previous SPA url as the referrer, origin-stripped: it
    // is redacted too, and stays relative.
    expect(
      beforeSend("pageview", {
        url: "https://app.eccos.chat/events",
        referrer: "/reset-password?token=t&utm_source=mail",
      }),
    ).toEqual({ url: "https://app.eccos.chat/events", referrer: "/reset-password?utm_source=mail" });
    expect(beforeSend("pageview", { url: "https://app.eccos.chat/x", referrer: "" }).url).toBe(
      "https://app.eccos.chat/x",
    );
    expect(beforeSend("pageview", null)).toBeNull();
  });
});

describe("tracking helpers never throw", () => {
  test("with no browser tracker, both helpers are silent no-ops", () => {
    expect(() => track("signup_submit")).not.toThrow();
    expect(() => track("connect_choice", { path: "new-number" })).not.toThrow();
    expect(() => trackSessionEvent({ event: "FINISH" })).not.toThrow();
    expect(() => trackSessionEvent({ event: "CANCEL", currentStep: "PHONE_NUMBER" })).not.toThrow();
    expect(() => trackSessionEvent({ event: "ERROR", errorCode: "132000" })).not.toThrow();
  });
});
