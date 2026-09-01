import { describe, expect, test } from "bun:test";
import {
  SESSION_EVENT_TYPE,
  isFinishEvent,
  isMetaOrigin,
  loginOptions,
  parseSessionEvent,
} from "../src/lib/embedded-signup";

/**
 * Session logging — the `message` listener Meta's coexistence requirements call
 * a "must", and the only source of the screen a customer abandoned on and the
 * error code they reported.
 *
 * The parser is pure so this half can be tested properly. The browser half —
 * loading sdk.js, `FB.login`, the listener actually firing — is NOT covered
 * here: these tests run under `bun test` with no DOM, and a test that mocked
 * `window.FB` would prove only that the mock was called.
 */
describe("origin checking is stricter than Meta's own sample", () => {
  test("accepts facebook.com and its subdomains over https", () => {
    expect(isMetaOrigin("https://facebook.com")).toBe(true);
    expect(isMetaOrigin("https://www.facebook.com")).toBe(true);
    expect(isMetaOrigin("https://web.facebook.com")).toBe(true);
  });

  /**
   * Meta's published snippet is `event.origin.endsWith('facebook.com')`, which
   * accepts every one of these. This payload reaches the audit log, so the
   * bug is not worth copying.
   */
  test("rejects the lookalikes a suffix check would let through", () => {
    expect(isMetaOrigin("https://notfacebook.com")).toBe(false);
    expect(isMetaOrigin("https://evil-facebook.com")).toBe(false);
    expect(isMetaOrigin("https://facebook.com.attacker.test")).toBe(false);
  });

  test("rejects plaintext and anything unparseable", () => {
    expect(isMetaOrigin("http://www.facebook.com")).toBe(false);
    expect(isMetaOrigin("null")).toBe(false);
    expect(isMetaOrigin("")).toBe(false);
  });
});

describe("parsing an Embedded Signup session event", () => {
  const ORIGIN = "https://www.facebook.com";

  test("reads the abandonment event, which nothing else reports", () => {
    const parsed = parseSessionEvent(
      ORIGIN,
      JSON.stringify({
        type: SESSION_EVENT_TYPE,
        event: "CANCEL",
        data: { current_step: "PHONE_NUMBER_SETUP" },
      }),
    );
    expect(parsed).toEqual({ event: "CANCEL", currentStep: "PHONE_NUMBER_SETUP" });
  });

  test("reads a customer-reported error, including the id Meta support asks for", () => {
    const parsed = parseSessionEvent(
      ORIGIN,
      JSON.stringify({
        type: SESSION_EVENT_TYPE,
        event: "CANCEL",
        data: {
          error_message: "Your verified name violates WhatsApp guidelines.",
          error_code: "524126",
          session_id: "f34b51dab5e0498",
          timestamp: "1746041036",
        },
      }),
    );
    expect(parsed).toEqual({
      event: "CANCEL",
      errorCode: "524126",
      sessionId: "f34b51dab5e0498",
    });
    // The human-readable message is Meta's copy shown to the customer; the code
    // and session id are what a support ticket needs, and the audit log takes
    // identifiers rather than prose.
    expect(JSON.stringify(parsed)).not.toContain("violates");
  });

  test("reads the coexistence completion, which carries only a WABA id", () => {
    const parsed = parseSessionEvent(ORIGIN, {
      type: SESSION_EVENT_TYPE,
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      data: { waba_id: "WABA_1" },
      version: 3,
    });
    expect(parsed).toEqual({
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      wabaId: "WABA_1",
    });
  });

  test("reads a full completion, and never the authorization code", () => {
    const parsed = parseSessionEvent(ORIGIN, {
      type: SESSION_EVENT_TYPE,
      event: "FINISH",
      // A `code` here would be Meta changing the contract; the parser has no
      // field for it either way, so it cannot reach the audit log.
      data: { waba_id: "WABA_1", phone_number_id: "PN_1", code: "AQB-secret" },
    });
    expect(parsed).toEqual({ event: "FINISH", wabaId: "WABA_1", phoneNumberId: "PN_1" });
    expect(JSON.stringify(parsed)).not.toContain("AQB-secret");
  });

  test("stays silent for everything that is not an Embedded Signup message", () => {
    // Another window on the page, a browser extension, a dev-tools bridge.
    expect(parseSessionEvent(ORIGIN, { type: "webpack/ok" })).toBeNull();
    expect(parseSessionEvent(ORIGIN, "not json at all")).toBeNull();
    expect(parseSessionEvent(ORIGIN, { type: SESSION_EVENT_TYPE })).toBeNull();
    expect(parseSessionEvent("https://evil.test", { type: SESSION_EVENT_TYPE, event: "FINISH" })).toBeNull();
  });

  test("treats every FINISH variant as completion, CANCEL as not", () => {
    expect(isFinishEvent("FINISH")).toBe(true);
    expect(isFinishEvent("FINISH_ONLY_WABA")).toBe(true);
    expect(isFinishEvent("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING")).toBe(true);
    expect(isFinishEvent("CANCEL")).toBe(false);
  });
});

/**
 * The `FB.login` options. Under v4 the configuration id carries the entire flow
 * definition, so what must NOT be here matters as much as what is.
 */
describe("the v4 FB.login options", () => {
  test("asks for a code the server can exchange, not a client token", () => {
    expect(loginOptions("CONFIG_1")).toEqual({
      config_id: "CONFIG_1",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {} },
    });
  });

  test("carries none of the v2 extras — those are the configuration's job now", () => {
    const options = JSON.stringify(loginOptions("CONFIG_1"));
    expect(options).not.toContain("featureType");
    expect(options).not.toContain("whatsapp_business_app_onboarding");
    expect(options).not.toContain("sessionInfoVersion");
    expect(options).not.toContain("version");
  });
});
