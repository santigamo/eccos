import { describe, expect, test } from "bun:test";
import { closedAt, helpContext, helpMailto, troubleFor } from "../src/lib/connect-trouble";

const meta = (code: string) => ({
  tone: "meta" as const,
  code,
  error: { title: "t", body: "b", refs: `Meta error ${code} · session s1` },
});

describe("troubleFor", () => {
  test("Meta's codes open their own screens, anything else the generic report", () => {
    expect(troubleFor(meta("3441067"))).toBe("provider");
    expect(troubleFor(meta("3441069"))).toBe("regular-app");
    expect(troubleFor(meta("3441075"))).toBe("pin");
    expect(troubleFor(meta("2655145"))).toBe("meta");
  });

  test("the browser's refusal, a closed window and a failure each have a screen", () => {
    expect(troubleFor({ tone: "blocked", text: "x" })).toBe("popup");
    expect(troubleFor({ tone: "notice", text: "x" })).toBe("closed");
    expect(troubleFor({ tone: "error", text: "x" })).toBe("error");
  });

  test("a window that may be behind this one is not a problem yet", () => {
    expect(troubleFor({ tone: "slow", text: "x" })).toBeNull();
    expect(troubleFor(null)).toBeNull();
  });
});

describe("help to the founder", () => {
  test("names the screen Meta's window closed on only when it is known", () => {
    expect(closedAt({ tone: "notice", text: "x", step: "WHATSAPP_BUSINESS_APP_ONBOARDING_QR_CODE" })).toBe(
      "Closed at the QR code screen",
    );
    expect(closedAt({ tone: "notice", text: "x", step: "PHONE_NUMBER_SETUP" })).toBeNull();
  });

  test("the context carries the path, the step, and Meta's references", () => {
    expect(helpContext({ path: "business-app", stage: "Connect", feedback: meta("3441067") })).toEqual([
      "Path: WhatsApp Business app",
      "Stopped at: Connect",
      "Meta error 3441067 · session s1",
    ]);
    expect(helpContext({ path: null, stage: "Get ready", feedback: null })).toEqual([
      "Path: not chosen yet",
      "Stopped at: Get ready",
    ]);
  });

  test("the mail goes to the founder with the words first, then the context", () => {
    const href = helpMailto("It showed a red message.", ["Path: New number"]);
    expect(href.startsWith("mailto:santi@eccos.chat?")).toBe(true);
    expect(decodeURIComponent(href.split("body=")[1] ?? "")).toBe("It showed a red message.\n\nPath: New number");
  });
});
