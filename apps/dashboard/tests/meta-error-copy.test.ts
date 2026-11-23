import { describe, expect, test } from "bun:test";
import { metaErrorCopy, outboundErrorReading, WINDOW_CLOSED_CODE } from "../src/lib/failure";

const KNOWN = [
  "131047", "131026", "131049", "131050", "131051", "131053", "131056", "130429",
  "131042", "131031", "368", "132000", "132001", "132015", "132016",
];

describe("metaErrorCopy", () => {
  test("the closed window says to send a template", () => {
    const copy = metaErrorCopy(WINDOW_CLOSED_CODE);
    expect(copy.title).toBe("Outside the 24-hour window");
    expect(copy.detail).toContain("approved template");
  });

  test("a known code reads in the console's words, not Meta's", () => {
    expect(metaErrorCopy("131026", "Message undeliverable").title).toBe("Recipient cannot receive messages");
    expect(metaErrorCopy("131049").detail).toContain("not an Eccos error");
  });

  test("an unknown code falls back to Meta's sentence, and never claims Meta gave no reason", () => {
    expect(metaErrorCopy("999999", "Something odd")).toEqual({ title: "Meta error", detail: "Something odd" });
    expect(metaErrorCopy("999999").detail).toBe("The console has no description for this code yet.");
    expect(metaErrorCopy(null).detail).toBe("Meta did not say why.");
    expect(metaErrorCopy(null, "Timeout").detail).toBe("Timeout");
  });

  test("every known code has its own title, and no copy uses a dash", () => {
    const titles = new Set<string>();
    for (const code of KNOWN) {
      const copy = metaErrorCopy(code);
      expect(copy.title, code).not.toBe("Meta error");
      expect(`${copy.title} ${copy.detail}`, code).not.toMatch(/[—–]/);
      titles.add(copy.title);
    }
    expect(titles.size).toBe(KNOWN.length);
  });
});

describe("outboundErrorReading", () => {
  test("nothing stored and nothing failed reads as empty", () => {
    expect(outboundErrorReading(null, undefined)).toBeNull();
  });

  test("a send that never reached Meta keeps its own words, not 'Meta error'", () => {
    expect(outboundErrorReading(JSON.stringify("fetch failed"), undefined)).toEqual({
      code: null,
      title: null,
      detail: "fetch failed",
    });
  });

  test("a refused send with a code reads in the console's words", () => {
    const raw = JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } });
    expect(outboundErrorReading(raw, undefined)?.title).toBe("Outside the 24-hour window");
  });

  test("an accepted send that failed later reads from the trail's code", () => {
    expect(outboundErrorReading(null, "131047")?.title).toBe("Outside the 24-hour window");
    expect(outboundErrorReading(null, null)?.detail).toBe("Meta did not say why.");
  });
});
