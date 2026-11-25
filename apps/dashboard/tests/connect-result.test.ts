import { describe, expect, test } from "bun:test";
import type { ConnectExchangeResult } from "@eccos/gateway-contract";
import {
  CONNECT_CANCELLED_MESSAGE,
  QR_CODE_STEP,
  SIGNUP_ERRORS,
  type SignupErrorCode,
  UNKNOWN_SIGNUP_ERROR_TITLE,
  connectCancelledMessage,
  connectAudit,
  judgeExchange,
  popupBlockedMessage,
  popupHintMessage,
  reportedSignupError,
  returnPathFor,
  secondsBucket,
  watchPopup,
} from "../src/lib/connect-result";
import { en } from "../src/lib/connect-link/en";
import { es } from "../src/lib/connect-link/es";

const phone = { waba_id: "100", phone_number_id: "200", display_phone_number: "+1 555 0100" };

function ok(over: Partial<Extract<ConnectExchangeResult, { ok: true }>> = {}): ConnectExchangeResult {
  return {
    ok: true,
    waba_id: "100",
    phone_number_id: "200",
    display_phone_number: "+1 555 0100",
    connected: [phone],
    status: "active",
    ...over,
  };
}

describe("judgeExchange", () => {
  test("active and pending with a number land on /numbers", () => {
    expect(judgeExchange(ok())).toEqual({ navigate: true, outcome: "ok", skipped: 0 });
    expect(judgeExchange(ok({ status: "pending" }))).toMatchObject({ navigate: true, outcome: "ok" });
  });

  test("a WABA without a number lands on /numbers, which explains it", () => {
    expect(judgeExchange(ok({ connected: [], phone_number_id: "" }))).toMatchObject({
      navigate: true,
      outcome: "no_number",
    });
  });

  test("failed provisioning lands on /numbers with no retry invitation", () => {
    expect(judgeExchange(ok({ status: "failed" }))).toMatchObject({
      navigate: true,
      outcome: "provisioning_failed",
    });
  });

  test("failed provisioning wins over an empty connected list", () => {
    expect(judgeExchange(ok({ status: "failed", connected: [] }))).toMatchObject({
      outcome: "provisioning_failed",
    });
  });

  test("skipped accounts are counted from the warnings", () => {
    expect(judgeExchange(ok({ warnings: ["a", "b"] }))).toMatchObject({ skipped: 2 });
    expect(returnPathFor("/numbers", 2)).toBe("/numbers?connectSkipped=2");
    expect(returnPathFor("/numbers", 0)).toBe("/numbers");
  });

  test("every gateway failure code says something and keeps its code", () => {
    for (const code of ["state", "denied", "owned", "no_waba", "failed"] as const) {
      const verdict = judgeExchange({ ok: false, error: "raw upstream text", code });
      expect(verdict).toMatchObject({ navigate: false, outcome: code });
      if (verdict.navigate) throw new Error("unreachable");
      expect(verdict.message.length).toBeGreaterThan(20);
      expect(verdict.message).not.toContain("raw upstream text");
    }
  });

  test("copy has no em dashes and never blames Meta for our own errors", () => {
    for (const m of [connectCancelledMessage(), connectCancelledMessage(QR_CODE_STEP), popupBlockedMessage("app.eccos.chat"), popupHintMessage("app.eccos.chat")]) {
      expect(m).not.toContain("—");
    }
    const failed = judgeExchange({ ok: false, error: "x", code: "failed" });
    if (failed.navigate) throw new Error("unreachable");
    expect(failed.message).toBe("The connection could not be completed. Try again.");
  });
});

describe("connectAudit", () => {
  test("only a clean connect is a success; the rest log why", () => {
    expect(connectAudit(ok())).toEqual({ outcome: "success" });
    expect(connectAudit(ok({ status: "pending" }))).toEqual({ outcome: "success" });
    expect(connectAudit(ok({ status: "failed" }))).toEqual({
      outcome: "failed",
      detail: "provisioning_failed",
    });
    expect(connectAudit(ok({ connected: [] }))).toEqual({ outcome: "failed", detail: "no_number" });
    expect(connectAudit({ ok: false, code: "owned", error: "taken" })).toEqual({
      outcome: "failed",
      detail: "taken",
    });
  });
});

describe("popup copy", () => {
  test("the blocked message names the host and the way out", () => {
    const m = popupBlockedMessage("app.eccos.chat");
    expect(m).toContain("app.eccos.chat");
    expect(m).toContain("allow pop-ups");
  });
  test("the hint claims neither a block nor an open window", () => {
    const m = popupHintMessage("app.eccos.chat");
    expect(m).toContain("It may be behind this one");
    expect(m).toContain("If nothing opened, allow pop-ups for app.eccos.chat");
    expect(m).not.toContain("blocked");
  });
});

describe("connectCancelledMessage", () => {
  test("is the generic notice for an unknown or ordinary step", () => {
    expect(connectCancelledMessage()).toBe(CONNECT_CANCELLED_MESSAGE);
    expect(connectCancelledMessage("PHONE_NUMBER_SETUP")).toBe(CONNECT_CANCELLED_MESSAGE);
  });
  test("names the QR step and the activity requirement", () => {
    const m = connectCancelledMessage(QR_CODE_STEP);
    expect(m).toContain("closed at the QR code step. Nothing changed.");
    expect(m).toContain("use it in the WhatsApp Business app for about a week");
  });
});

describe("reportedSignupError", () => {
  test("a plain cancel is not an error", () => {
    expect(reportedSignupError()).toBeNull();
    expect(reportedSignupError(QR_CODE_STEP, {})).toBeNull();
    expect(reportedSignupError(undefined, { sessionId: "f34b51d" })).toBeNull();
  });
  test("a known code gives a title, a cause and action, and Meta's references", () => {
    expect(reportedSignupError(QR_CODE_STEP, { code: "3441067", sessionId: "f34b51d" })).toEqual({
      title: "Another business portfolio holds this number",
      body: "Usually your previous WhatsApp provider. Ask them to release the number, then start again.",
      refs: "Meta error 3441067 · session f34b51d",
    });
  });
  test("an unknown code gets the generic title, the cancel notice for its step, and its references", () => {
    expect(reportedSignupError(undefined, { code: "524126" })).toEqual({
      title: UNKNOWN_SIGNUP_ERROR_TITLE,
      body: CONNECT_CANCELLED_MESSAGE,
      refs: "Meta error 524126",
    });
    expect(reportedSignupError(QR_CODE_STEP, { code: "toString", sessionId: "s" })?.body).toBe(
      connectCancelledMessage(QR_CODE_STEP),
    );
  });
  test("every code has a short title and a body, with no dashes in any language", () => {
    for (const code of Object.keys(SIGNUP_ERRORS) as SignupErrorCode[]) {
      for (const [where, copy] of [
        ["console", SIGNUP_ERRORS[code]],
        ["en", en.signupErrors[code]],
        ["es", es.signupErrors[code]],
      ] as const) {
        expect(copy.title.split(" ").length, `${where} ${code}`).toBeLessThanOrEqual(9);
        expect(copy.body.length, `${where} ${code}`).toBeGreaterThan(10);
        expect(`${copy.title} ${copy.body}`, `${where} ${code}`).not.toMatch(/[—–]/);
      }
    }
    for (const code of ["3441067", "3441069", "3441070", "2655145", "2655123", "3441093", "2494064"]) {
      expect(Object.hasOwn(SIGNUP_ERRORS, code), code).toBe(true);
    }
  });
});

describe("secondsBucket", () => {
  test("rounds to coarse buckets", () => {
    expect(secondsBucket(3_000)).toBe("<10s");
    expect(secondsBucket(20_000)).toBe("<30s");
    expect(secondsBucket(114_000)).toBe("<2m");
    expect(secondsBucket(4 * 60_000)).toBe("<10m");
    expect(secondsBucket(3_600_000)).toBe("10m+");
  });
});
