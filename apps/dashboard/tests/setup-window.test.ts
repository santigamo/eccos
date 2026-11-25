import { describe, expect, test } from "bun:test";
import { daysLeft, earlyAccessMessage, timeLeft, weekdayTime } from "../src/lib/setup-window";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("hour countdowns, rounded down", () => {
  test("41h59m reads 1 d 17 h, never 42 hours", () => {
    expect(timeLeft(42 * HOUR - MINUTE)).toBe("1 d 17 h left");
    expect(timeLeft(HOUR + 59 * MINUTE)).toBe("1 h left");
    expect(timeLeft(59.5 * MINUTE)).toBe("59 min left");
    expect(timeLeft(10_000)).toBe("1 min left");
  });

});

describe("whole-day deadlines round up", () => {
  test("exactly 5 days reads 5 days", () => {
    expect(daysLeft(5 * DAY)).toBe("5 days left");
    expect(earlyAccessMessage(5 * DAY, 0)).toBe("Early access ends in 5 days. Subscribe to keep sending.");
  });

  test("4 d 23 h still reads 5 days", () => {
    expect(daysLeft(5 * DAY - HOUR)).toBe("5 days left");
    expect(earlyAccessMessage(5 * DAY - HOUR, 0)).toBe("Early access ends in 5 days. Subscribe to keep sending.");
  });

  test("less than a day reads 1 day", () => {
    expect(daysLeft(23 * HOUR)).toBe("1 day left");
    expect(earlyAccessMessage(MINUTE, 0)).toBe("Early access ends in 1 day. Subscribe to keep sending.");
  });
});

describe("deadlines", () => {
  const at = Date.UTC(2026, 10, 28, 9, 42);

  test("before hydration: the date only, with no time zone to mismatch", () => {
    expect(weekdayTime(at)).toBe("Sat 28 Nov");
  });

  test("after hydration: the viewer's local time, never labelled UTC", () => {
    const local = weekdayTime(at, true);
    const hours = String(new Date(at).getHours()).padStart(2, "0");
    expect(local).toMatch(new RegExp(` at ${hours}:42$`));
    expect(local).not.toContain("UTC");
  });
});
