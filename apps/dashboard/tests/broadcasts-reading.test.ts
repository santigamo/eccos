import { describe, expect, test } from "bun:test";
import {
  broadcastPace,
  broadcastState,
  broadcastStateLabel,
  broadcastsFirstRun,
  normalizeBroadcastId,
  normalizeRecipientStatus,
  normalizeSeqCursor,
  recipientStateLabel,
} from "../src/lib/broadcasts";

const counts = { queued: 4, sending: 1, sent: 10, failed: 2, unknown: 1, cancelled: 3 };

describe("broadcast state words", () => {
  test("a running broadcast reads as sending, the rest as themselves", () => {
    expect(broadcastStateLabel({ status: "running" })).toBe("sending");
    for (const status of ["completed", "cancelled", "halted"] as const) {
      expect(broadcastStateLabel({ status })).toBe(status);
    }
  });

  test("a recipient never reads delivered; an unknown outcome says so", () => {
    expect(recipientStateLabel({ status: "unknown" })).toBe("unknown outcome");
    for (const status of ["queued", "sending", "sent", "failed", "cancelled"] as const) {
      expect(recipientStateLabel({ status })).toBe(status);
    }
  });
});

describe("state with its reason", () => {
  test("a running broadcast reads paused, with its queue, while the workspace's sending is paused", () => {
    expect(broadcastState({ status: "running", counts: { ...counts, queued: 1241 }, haltReason: null }, true)).toEqual({
      label: "paused",
      reason: "1,241 waiting",
    });
    expect(broadcastState({ status: "running", counts, haltReason: null }, false)).toEqual({
      label: "sending",
      reason: null,
    });
    expect(broadcastState({ status: "completed", counts, haltReason: null }, true)).toEqual({
      label: "completed",
      reason: null,
    });
  });

  test("a halted broadcast carries its reason", () => {
    expect(broadcastState({ status: "halted", counts, haltReason: "first 20 sends failed" }, false)).toEqual({
      label: "halted",
      reason: "first 20 sends failed",
    });
  });
});

describe("pace", () => {
  test("agrees with the gateway's ticks: 80% of the account rate", async () => {
    const { pacing } = await import("../../gateway/src/broadcasts");
    for (const rate of [1, 7, 10, 60, 80, 600, 1000]) {
      const { perTick, tickMs } = pacing(rate);
      expect(broadcastPace(rate)).toBe(Math.round((perTick * 60_000) / tickMs));
    }
    expect(broadcastPace(60)).toBe(48);
    expect(broadcastPace(600)).toBe(480);
  });
});

describe("first run", () => {
  test("only the first page with no rows is a first run", () => {
    expect(broadcastsFirstRun([], undefined)).toBe(true);
    expect(broadcastsFirstRun([], "bc_x")).toBe(false);
    expect(broadcastsFirstRun([{}], undefined)).toBe(false);
  });
});

describe("search normalizers", () => {
  test("recipient status: one of the six, else undefined", () => {
    expect(normalizeRecipientStatus("failed")).toBe("failed");
    expect(normalizeRecipientStatus("delivered")).toBeUndefined();
    expect(normalizeRecipientStatus(3)).toBeUndefined();
  });

  test("seq cursor: digits only", () => {
    expect(normalizeSeqCursor("12")).toBe("12");
    expect(normalizeSeqCursor(7)).toBe("7");
    expect(normalizeSeqCursor("-1")).toBeUndefined();
    expect(normalizeSeqCursor("1e3")).toBeUndefined();
  });

  test("broadcast id: bc_ plus 32 hex", () => {
    const id = `bc_${"0f".repeat(16)}`;
    expect(normalizeBroadcastId(id)).toBe(id);
    expect(normalizeBroadcastId("bc_short")).toBeUndefined();
    expect(normalizeBroadcastId(undefined)).toBeUndefined();
  });
});
