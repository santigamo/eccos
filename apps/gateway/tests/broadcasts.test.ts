import { describe, expect, test } from "bun:test";
import {
  classifySendFailure,
  MAX_BROADCAST_RECIPIENTS,
  pacing,
  parseBroadcastRequest,
  recipientMessage,
  throttleDelayMs,
} from "../src/broadcasts";

const codes = (errorCode: number | null) => ({ errorCode, errorSubcode: null, errorType: null });
const template = { name: "promo", language: { code: "es" } };

describe("parseBroadcastRequest", () => {
  test("reads the template, the language in either form, and per-recipient components", () => {
    const parsed = parseBroadcastRequest({
      template: { name: "promo", language: "es", components: [{ type: "body" }] },
      recipients: [{ to: "34600000001" }, { to: "34600000002", components: [] }],
    });
    expect(parsed).toEqual({
      ok: true,
      duplicates: 0,
      request: {
        templateName: "promo",
        language: "es",
        defaultComponents: [{ type: "body" }],
        recipients: [{ to: "34600000001" }, { to: "34600000002", components: [] }],
      },
    });
  });

  test("drops a repeated recipient, however it is written, and counts it", () => {
    const parsed = parseBroadcastRequest({ template, recipients: [{ to: "+34 600 000 001" }, { to: "34600000001" }] });
    expect(parsed).toMatchObject({ ok: true, duplicates: 1, request: { recipients: [{ to: "+34 600 000 001" }] } });
  });

  test("names every invalid recipient and refuses the whole request", () => {
    const parsed = parseBroadcastRequest({ template, recipients: [{ to: "34600000001" }, { to: "x" }, {}] });
    expect(parsed).toMatchObject({ ok: false, invalid: [{ index: 1 }, { index: 2 }] });
  });

  test("refuses a bad template, no recipients, or too many", () => {
    expect(parseBroadcastRequest({ template: { name: "Promo!", language: "es" }, recipients: [{ to: "34600000001" }] }).ok).toBe(false);
    expect(parseBroadcastRequest({ template: { name: "promo", language: "spanish" }, recipients: [{ to: "34600000001" }] }).ok).toBe(false);
    expect(parseBroadcastRequest({ template, recipients: [] }).ok).toBe(false);
    const many = Array.from({ length: MAX_BROADCAST_RECIPIENTS + 1 }, (_, i) => ({ to: `346${String(i).padStart(8, "0")}` }));
    expect(parseBroadcastRequest({ template, recipients: many }).ok).toBe(false);
  });

  test("a BSUID is a recipient", () => {
    expect(parseBroadcastRequest({ template, recipients: [{ to: "US.13491208655302741918" }] }).ok).toBe(true);
  });
});

describe("classifySendFailure", () => {
  test("an unknown outcome wins over a throttle code: it may have been sent", () => {
    expect(classifySendFailure(503, true, codes(130429))).toBe("unknown");
  });

  test("a parameter error fails one recipient with its own values, and halts on the template's defaults", () => {
    expect(classifySendFailure(400, false, codes(132000), true)).toBe("failed");
    expect(classifySendFailure(400, false, codes(132000), false)).toBe("halt");
  });

  test("number-wide refusals halt", () => {
    expect(classifySendFailure(400, false, codes(131048))).toBe("halt");
    expect(classifySendFailure(400, false, codes(368))).toBe("halt");
  });

  test("throttling is retried; it was not sent", () => {
    expect(classifySendFailure(429, false, codes(null))).toBe("throttled");
    expect(classifySendFailure(400, false, codes(130429))).toBe("throttled");
    expect(classifySendFailure(400, false, codes(131056))).toBe("throttled");
  });

  test("an unknown outcome is never retried", () => {
    expect(classifySendFailure(503, true, codes(1))).toBe("unknown");
    expect(classifySendFailure(0, true, codes(null))).toBe("unknown");
  });

  test("token, account and template errors halt the broadcast; the rest fail one recipient", () => {
    expect(classifySendFailure(401, false, codes(190))).toBe("halt");
    expect(classifySendFailure(400, false, codes(132001))).toBe("halt");
    expect(classifySendFailure(400, false, codes(null))).toBe("failed");
    expect(classifySendFailure(400, false, codes(131026))).toBe("failed");
  });
});

describe("pacing", () => {
  test("a broadcast uses 80% of the rate, leaving the rest to single sends", () => {
    expect(pacing(600)).toEqual({ perTick: 8, tickMs: 1_000 });
    expect(pacing(60)).toEqual({ perTick: 1, tickMs: 1_250 });
  });

  test("throttle backoff doubles from 5 s up to 5 min", () => {
    expect([1, 2, 3].map(throttleDelayMs)).toEqual([5_000, 10_000, 20_000]);
    expect(throttleDelayMs(20)).toBe(300_000);
  });
});

test("recipientMessage builds Meta's template message", () => {
  expect(recipientMessage("promo", "es", "34600000001", null)).toEqual({
    to: "34600000001",
    type: "template",
    template: { name: "promo", language: { code: "es" } },
  });
});
