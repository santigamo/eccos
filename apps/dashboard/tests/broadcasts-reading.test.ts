import { describe, expect, test } from "bun:test";
import {
  attemptedCount,
  broadcastStateLabel,
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

describe("counts", () => {
  test("attempted excludes queued, sending and cancelled", () => {
    expect(attemptedCount(counts)).toBe(13);
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
