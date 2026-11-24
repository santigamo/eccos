import { describe, expect, test } from "bun:test";
import type { ConnectExchangeResult } from "@eccos/gateway-contract";
import {
  CONNECT_CANCELLED_MESSAGE,
  QR_CODE_STEP,
  SIGNUP_ERRORS,
  type SignupErrorCode,
  connectCancelledMessage,
  connectAudit,
  judgeExchange,
  popupBlockedMessage,
  popupHintMessage,
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
    for (const m of [connectCancelledMessage(), connectCancelledMessage(QR_CODE_STEP, { code: "1", sessionId: "s" }), popupBlockedMessage("app.eccos.chat"), popupHintMessage("app.eccos.chat")]) {
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
  test("appends Meta's references for a reported error, on any step", () => {
    for (const step of [undefined, QR_CODE_STEP]) {
      expect(connectCancelledMessage(step, { code: "524126", sessionId: "f34b51d" })).toEndWith(
        "Meta reported error 524126, session f34b51d. Quote both if you contact support.",
      );
    }
    expect(connectCancelledMessage(undefined, { sessionId: "f34b51d" })).toEndWith(
      "Meta reported session f34b51d. Quote it if you contact support.",
    );
    expect(connectCancelledMessage(undefined, {})).toBe(CONNECT_CANCELLED_MESSAGE);
  });
  test("a known Meta code says what happened and what to do, and keeps the references", () => {
    const m = connectCancelledMessage(QR_CODE_STEP, { code: "3441067", sessionId: "f34b51d" });
    expect(m).toStartWith(SIGNUP_ERRORS["3441067"]);
    expect(m).toContain("business portfolio you do not manage");
    expect(m).toEndWith("Meta reported error 3441067, session f34b51d. Quote both if you contact support.");
  });
  test("an unknown code keeps the generic notice and its references", () => {
    expect(connectCancelledMessage(undefined, { code: "524126" })).toBe(
      `${CONNECT_CANCELLED_MESSAGE} Meta reported error 524126. Quote it if you contact support.`,
    );
    expect(connectCancelledMessage(undefined, { code: "toString" })).toStartWith(CONNECT_CANCELLED_MESSAGE);
  });
  test("the phone-setup codes are covered, with no dashes in any language", () => {
    for (const code of Object.keys(SIGNUP_ERRORS) as SignupErrorCode[]) {
      expect(SIGNUP_ERRORS[code], code).not.toMatch(/[—–]/);
      for (const copy of [en, es]) expect(copy.signupErrors[code], `${copy.lang} ${code}`).not.toMatch(/[—–]/);
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
