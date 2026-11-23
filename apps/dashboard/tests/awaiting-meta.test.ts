import { describe, expect, test } from "bun:test";
import { AWAITING_WINDOW_MS, awaitingMeta } from "../src/lib/awaiting-meta";
import type { OutboundRow } from "../src/server/gateway";

const NOW = 1_800_000_000_000;

function row(status: string, ageMs: number, trail: string[] = []): OutboundRow {
  return {
    id: 1,
    transport_message_id: status === "sent" ? "wamid.x" : null,
    recipient: "34600000000",
    phone_number_id: "pn",
    request: "{}",
    status,
    error: null,
    created_at: NOW - ageMs,
    trail: trail.map((type) => ({ type, at: NOW, errorCode: null, deliveryStatus: null, deliveryAttempts: null })),
  };
}

describe("awaitingMeta", () => {
  test("a fresh accepted send with no final status is awaited", () => {
    expect(awaitingMeta([row("sent", 1000)], NOW)).toBe(true);
    expect(awaitingMeta([row("sent", 1000, ["sent"])], NOW)).toBe(true);
  });

  test("delivered, read or failed in the trail settles it", () => {
    for (const final of ["delivered", "read", "failed"]) {
      expect(awaitingMeta([row("sent", 1000, ["sent", final])], NOW)).toBe(false);
    }
  });

  test("a send Meta refused has nothing to wait for", () => {
    expect(awaitingMeta([row("failed", 1000)], NOW)).toBe(false);
  });

  test("past the window the page stops asking", () => {
    expect(awaitingMeta([row("sent", AWAITING_WINDOW_MS)], NOW)).toBe(false);
    expect(awaitingMeta([row("sent", AWAITING_WINDOW_MS - 1)], NOW)).toBe(true);
  });

  test("one awaited row among settled ones is enough; none is false", () => {
    expect(awaitingMeta([row("sent", 1000, ["read"]), row("sent", 2000)], NOW)).toBe(true);
    expect(awaitingMeta([], NOW)).toBe(false);
  });
});
