import { describe, expect, test } from "bun:test";
import {
  normalizeScheduledStatus,
  normalizeScheduleKey,
  endedPhrase,
  readsSoonestFirst,
  scheduledOutcome,
} from "../src/lib/scheduled";

describe("normalizeScheduledStatus", () => {
  test("accepts the six statuses and nothing else", () => {
    for (const status of ["pending", "sending", "sent", "failed", "unknown", "cancelled"]) {
      expect(normalizeScheduledStatus(status)).toBe(status as never);
    }
    expect(normalizeScheduledStatus("queued")).toBeUndefined();
    expect(normalizeScheduledStatus(undefined)).toBeUndefined();
  });
});

describe("normalizeScheduleKey", () => {
  test("keeps the gateway's bounds", () => {
    expect(normalizeScheduleKey("a".repeat(128))).toBeDefined();
    expect(normalizeScheduleKey("a".repeat(129))).toBeUndefined();
    expect(normalizeScheduleKey("")).toBeUndefined();
    expect(normalizeScheduleKey("appt:2026-11.04_x")).toBe("appt:2026-11.04_x");
    expect(normalizeScheduleKey("a/b")).toBeUndefined();
    expect(normalizeScheduleKey(12)).toBeUndefined();
  });
});

describe("readsSoonestFirst", () => {
  test("is true only while a send can still go out", () => {
    expect(readsSoonestFirst("pending")).toBe(true);
    expect(readsSoonestFirst("sending")).toBe(true);
    for (const status of ["sent", "failed", "unknown", "cancelled"] as const) {
      expect(readsSoonestFirst(status)).toBe(false);
    }
  });
});

describe("scheduledOutcome", () => {
  const row = (over: Record<string, unknown>) => ({
    status: "pending" as const,
    messageId: null,
    failureReason: null,
    error: null,
    ...over,
  });

  test("sent shows the message", () => {
    expect(scheduledOutcome(row({ status: "sent", messageId: "wamid.1" }))).toEqual({
      kind: "message",
      messageId: "wamid.1",
    });
  });

  test("failed reads expired or Meta's error", () => {
    expect(scheduledOutcome(row({ status: "failed", failureReason: "expired" }))).toEqual({ kind: "expired" });
    expect(scheduledOutcome(row({ status: "failed", failureReason: "rejected", error: "{}" }))).toEqual({
      kind: "error",
      raw: "{}",
    });
  });

  test("unknown reads its stored error, or just unknown", () => {
    expect(scheduledOutcome(row({ status: "unknown", error: "{}" }))).toEqual({ kind: "error", raw: "{}" });
    expect(scheduledOutcome(row({ status: "unknown" }))).toEqual({ kind: "unknown" });
  });

  test("nothing has happened to pending, sending or cancelled", () => {
    for (const status of ["pending", "sending", "cancelled"] as const) {
      expect(scheduledOutcome(row({ status }))).toBeNull();
    }
  });
});

describe("endedPhrase", () => {
  test("words each way a send can have ended", () => {
    expect(endedPhrase({ status: "sending", failureReason: null })).toBe("is being sent");
    expect(endedPhrase({ status: "sent", failureReason: null })).toBe("was sent");
    expect(endedPhrase({ status: "failed", failureReason: "expired" })).toBe("expired");
    expect(endedPhrase({ status: "failed", failureReason: "rejected" })).toBe("failed");
    expect(endedPhrase({ status: "unknown", failureReason: "unknown" })).toBe("has an unknown outcome");
  });
});
