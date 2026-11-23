import { describe, expect, test } from "bun:test";
import { metaErrorCopy, WINDOW_CLOSED_CODE } from "../src/lib/failure";

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

  test("an unknown code falls back to Meta's sentence, then to saying nothing was said", () => {
    expect(metaErrorCopy("999999", "Something odd")).toEqual({ title: "Meta error", detail: "Something odd" });
    expect(metaErrorCopy("999999")).toEqual({ title: "Meta error", detail: "Meta did not say why." });
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
