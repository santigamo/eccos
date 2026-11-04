import { describe, expect, test } from "bun:test";
import { parseScheduledRequest, SCHEDULE_KEY, scheduledFailedEvent } from "../src/scheduled";

const NOW = Date.parse("2026-11-04T10:00:00Z");
const template = { name: "reminder", language: { code: "es" } };
const body = (extra: Record<string, unknown> = {}) => ({ to: "34600000001", template, sendAt: NOW + 60_000, ...extra });

describe("parseScheduledRequest", () => {
  test("a minimal request defaults expiresAt to sendAt + 1 h", () => {
    const parsed = parseScheduledRequest(body(), NOW);
    expect(parsed).toEqual({
      ok: true,
      request: { to: "34600000001", templateName: "reminder", language: "es", sendAt: NOW + 60_000, expiresAt: NOW + 60_000 + 3600_000 },
    });
  });

  test("accepts ISO times with Z and with an offset", () => {
    const z = parseScheduledRequest(body({ sendAt: "2026-11-20T09:00:00Z" }), NOW);
    const offset = parseScheduledRequest(body({ sendAt: "2026-11-20T10:00:00+01:00" }), NOW);
    expect(z.ok && z.request.sendAt).toBe(Date.parse("2026-11-20T09:00:00Z"));
    expect(offset.ok && offset.request.sendAt).toBe(Date.parse("2026-11-20T09:00:00Z"));
  });

  test("refuses an ISO time without an offset", () => {
    expect(parseScheduledRequest(body({ sendAt: "2026-11-20T09:00:00" }), NOW)).toEqual({
      ok: false,
      error: "sendAt must be epoch milliseconds or an ISO 8601 time with a timezone",
    });
  });

  test("a past sendAt before its expiry is accepted", () => {
    expect(parseScheduledRequest(body({ sendAt: NOW - 60_000 }), NOW).ok).toBe(true);
  });

  test("refuses a past expiresAt, expiresAt <= sendAt and a bad expiresAt", () => {
    expect(parseScheduledRequest(body({ sendAt: NOW - 120_000, expiresAt: NOW - 60_000 }), NOW)).toEqual({
      ok: false,
      error: "expiresAt is in the past",
    });
    expect(parseScheduledRequest(body({ expiresAt: NOW + 60_000 }), NOW)).toEqual({
      ok: false,
      error: "expiresAt must be after sendAt",
    });
    expect(parseScheduledRequest(body({ expiresAt: "tomorrow" }), NOW)).toEqual({
      ok: false,
      error: "expiresAt must be epoch milliseconds or an ISO 8601 time with a timezone",
    });
  });

  test("refuses more than 90 days ahead", () => {
    expect(parseScheduledRequest(body({ sendAt: NOW + 91 * 24 * 3600_000 }), NOW)).toEqual({
      ok: false,
      error: "sendAt can be at most 90 days ahead",
    });
  });

  test("validates the recipient and takes template errors from parseTemplate", () => {
    expect(parseScheduledRequest(body({ to: "abc" }), NOW)).toEqual({
      ok: false,
      error: "to must be a phone number (5-15 digits) or a BSUID",
    });
    expect(parseScheduledRequest(body({ to: "US.13491208655302741918" }), NOW).ok).toBe(true);
    expect(parseScheduledRequest(body({ template: undefined }), NOW)).toEqual({ ok: false, error: "template is required" });
    expect(parseScheduledRequest(body({ template: { ...template, components: "x" } }), NOW)).toEqual({
      ok: false,
      error: "template.components must be an array",
    });
    expect(parseScheduledRequest(null, NOW)).toEqual({ ok: false, error: "invalid body" });
  });
});

describe("SCHEDULE_KEY", () => {
  test("accepts ids and uuids, refuses anything unsafe in a path", () => {
    for (const key of ["appt-8812", "a:b.c_d", "k".repeat(128)]) expect(SCHEDULE_KEY.test(key)).toBe(true);
    for (const key of ["", "k".repeat(129), "a/b", "a b", "é"]) expect(SCHEDULE_KEY.test(key)).toBe(false);
  });
});

describe("scheduledFailedEvent", () => {
  const row = { key: "appt-1", recipient: "34600000001", phone_number_id: "109" };

  test("carries Meta's code and message", () => {
    const error = { error: { code: 131026, message: "generic", error_data: { details: "Message undeliverable" } } };
    expect(scheduledFailedEvent(row, "rejected", error, 5)).toEqual({
      type: "scheduled_failed",
      scheduleKey: "appt-1",
      to: "34600000001",
      reason: "rejected",
      errorCode: "131026",
      errorMessage: "Message undeliverable",
      at: 5,
      phoneNumberId: "109",
    });
  });

  test("omits the error fields when Meta did not answer", () => {
    const event = scheduledFailedEvent(row, "expired", null, 5);
    expect(Object.keys(event).sort()).toEqual(["at", "phoneNumberId", "reason", "scheduleKey", "to", "type"]);
  });
});
