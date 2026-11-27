import { describe, expect, test } from "bun:test";
import {
  consoleKey,
  dayBounds,
  dstNote,
  instantOf,
  isSameSend,
  longDay,
  recipientProblem,
  resolvedWhen,
  scheduleFailureCopy,
  shortWhen,
  tomorrowAtNine,
  whenProblem,
  zoneName,
} from "../src/lib/schedule-draft";

const DAY = 86_400_000;
const MADRID = "Europe/Madrid";
const SAT_9_MADRID = Date.UTC(2026, 10, 28, 8);

describe("schedule draft", () => {
  test("defaults to tomorrow at 09:00 local, and reads it back as that instant", () => {
    const when = tomorrowAtNine(new Date(2026, 10, 27, 17, 30));
    expect(when).toEqual({ day: "2026-11-28", time: "09:00" });
    expect(instantOf(when)).toBe(new Date(2026, 10, 28, 9, 0).getTime());
    expect(tomorrowAtNine(new Date(2026, 11, 31, 23, 0)).day).toBe("2027-01-01");
  });

  test("an incomplete day or time is no instant", () => {
    expect(instantOf({ day: "", time: "09:00" })).toBeNull();
    expect(instantOf({ day: "2026-11-28", time: "" })).toBeNull();
  });

  test("the key is dated and suffixed, within the gateway's charset", () => {
    const key = consoleKey({ day: "2026-11-28", time: "09:00" }, "x7k2");
    expect(key).toBe("console-20261128-0900-x7k2");
    expect(key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  });

  test("a time must be in the future and at most 90 days ahead", () => {
    const now = Date.UTC(2026, 10, 27, 12);
    expect(whenProblem(null, now)).toBe("Pick a day and a time.");
    expect(whenProblem(now - 1, now)).toBe("Pick a time in the future. To send it now, use Send test on the template.");
    expect(whenProblem(now + DAY, now)).toBeNull();
    expect(whenProblem(now + 91 * DAY, now)).toBe("A send can be scheduled up to 90 days ahead (until 25 Feb 2027).");
    expect(dayBounds(new Date(2026, 10, 27))).toEqual({ min: "2026-11-27", max: "2027-02-25" });
  });

  test("the readback names the zone as a person does, and the primary reads short", () => {
    expect(longDay(SAT_9_MADRID, MADRID)).toBe("Saturday 28 November, 09:00");
    expect(zoneName(MADRID)).toBe("Madrid time");
    expect(zoneName("America/New_York")).toBe("New York time");
    expect(shortWhen(SAT_9_MADRID, MADRID)).toBe("Sat 28 Nov, 09:00");
  });

  test("a time DST skips or repeats gets one line, and the key follows the time it will send at", () => {
    const gap = { day: "2027-03-28", time: "02:30" };
    const gapAt = Date.UTC(2027, 2, 28, 1, 30); // where a Madrid browser resolves 02:30: 03:30 CEST
    expect(dstNote(gap, gapAt, MADRID)).toBe("02:30 does not exist on 28 Mar in Europe/Madrid; it will send at 03:30.");
    expect(consoleKey(resolvedWhen(gap, gapAt, MADRID), "x7k2")).toBe("console-20270328-0330-x7k2");
    const twice = { day: "2026-10-25", time: "02:30" };
    expect(dstNote(twice, Date.UTC(2026, 9, 25, 0, 30), MADRID)).toBe(
      "02:30 happens twice on 25 Oct in Europe/Madrid; it will send at the first, 02:30 CEST.",
    );
    expect(dstNote({ day: "2026-11-28", time: "09:00" }, SAT_9_MADRID, MADRID)).toBeNull();
    expect(dstNote(gap, null, MADRID)).toBeNull();
  });

  test("a number must carry its country code; a BSUID needs none", () => {
    expect(recipientProblem("600 111 222")).toBe("Include the country code, starting with +.");
    expect(recipientProblem(" +34 600 111 222")).toBeNull();
    expect(recipientProblem("US.13491208655302741918")).toBeNull();
  });

  test("a key_exists that is this very draft is a retry whose answer was lost", () => {
    const existing = {
      status: "pending" as const,
      to: "34600111222",
      sendAt: SAT_9_MADRID,
      template: { name: "reminder", language: "es" },
    };
    const draft = { to: "+34 600 111 222", sendAt: SAT_9_MADRID, templateName: "reminder", languageCode: "es" };
    expect(isSameSend(existing, draft)).toBe(true);
    expect(isSameSend({ ...existing, status: "sent" }, draft)).toBe(false);
    expect(isSameSend(existing, { ...draft, to: "+34 600 999 888" })).toBe(false);
    expect(isSameSend(existing, { ...draft, sendAt: SAT_9_MADRID + 60_000 })).toBe(false);
    expect(isSameSend(existing, { ...draft, languageCode: "ca" })).toBe(false);
  });

  test("a refusal that is not about the time is not worded as one", () => {
    expect(scheduleFailureCopy({ code: "invalid_request", detail: "template.components are too large" }, "x")).toEqual({
      title: "Not scheduled",
      detail: "Eccos refused this request.",
      secondary: "template.components are too large",
    });
  });

  test("a taken key names what holds it; a template refusal names Meta's status", () => {
    const existing = { status: "pending", sendAt: Date.UTC(2026, 10, 20, 8) } as never;
    expect(scheduleFailureCopy({ code: "key_exists", detail: null, existing }, "reminder (es)", MADRID).detail).toBe(
      "A send with this key already exists (pending for Fri 20 Nov, 09:00). Choose another key.",
    );
    expect(
      scheduleFailureCopy({ code: "template_not_approved", detail: null, templateStatus: "PAUSED" }, "reminder (es)").detail,
    ).toBe("reminder (es) is no longer approved: Meta now lists it as PAUSED. Nothing was scheduled.");
    expect(scheduleFailureCopy({ code: "invalid_time", detail: "sendAt can be at most 90 days ahead" }, "x")).toEqual({
      title: "Not scheduled",
      detail: "That time cannot be scheduled.",
      secondary: "sendAt can be at most 90 days ahead",
    });
  });
});
