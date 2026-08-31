import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResendNote,
  type ResendOutcome,
  resendVerificationOutcome,
} from "../src/components/auth/auth-page";

/**
 * eccos-hk5: the "Resend" button on the check-your-inbox screen is rate limited
 * (5 per 300s, apps/dashboard/src/auth/auth.ts). This pins the console half of
 * that: what the screen says when the limit trips, and — just as important —
 * what it still refuses to say about the address that was typed.
 *
 * Both pieces are dependency-free, so they render with plain `react-dom/server`
 * and no module mocks (same construction as connect-outcome.test.tsx).
 */

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function render(outcome: ResendOutcome | null): string {
  return renderToStaticMarkup(<ResendNote outcome={outcome} />);
}

describe("resendVerificationOutcome", () => {
  test("an answered request reads as sent", () => {
    const outcome = resendVerificationOutcome(200);
    expect(outcome.kind).toBe("sent");
    expect(outcome.message).toContain("sent again");
  });

  test("429 is a wait, not a claim that the mail went out", () => {
    const outcome = resendVerificationOutcome(429);
    expect(outcome.kind).toBe("limited");
    // The whole point: a limited resend must not read as a silent success.
    expect(outcome.message).not.toBe(resendVerificationOutcome(200).message);
    expect(outcome.message.toLowerCase()).not.toContain("sent");
    expect(outcome.message.toLowerCase()).toContain("wait");
  });

  test("a request with no verdict says so", () => {
    const outcome = resendVerificationOutcome(null);
    expect(outcome.kind).toBe("unreachable");
    expect(outcome.message).toContain("Could not reach");
  });

  test("anti-enumeration: every other answered status takes the sent path", () => {
    // Better Auth answers 200 for an unknown or already-verified address, so
    // only a real, unverified account can make this endpoint answer 4xx/5xx.
    // Surfacing that would make the screen an existence oracle.
    const sent = resendVerificationOutcome(200);
    for (const status of [400, 401, 403, 404, 422, 500, 502]) {
      expect(resendVerificationOutcome(status)).toEqual(sent);
    }
  });
});

describe("ResendNote", () => {
  test("the live region is mounted while empty, so it can announce", () => {
    const html = render(null);
    expect(html).toContain('aria-live="polite"');
    expect(text(html)).toBe("");
    // …and costs nothing on the resting screen: no class at all, so no margin
    // and no box where a note has not been earned.
    expect(html).not.toContain("class");
  });

  test("a tripped limit is visible and legible, not a red error", () => {
    const html = render(resendVerificationOutcome(429));
    expect(text(html)).toContain("Wait a few minutes");
    // Degraded ink (docs/DASHBOARD-DESIGN.md data rule 1), never the
    // destructive rail or the red banner's ink.
    expect(html).toContain("border-l-[#f0a020]");
    expect(html).not.toContain("#e03131");
    expect(html).not.toContain("#ff7777");
  });

  test("only an unanswered request gets the destructive rail", () => {
    const html = render(resendVerificationOutcome(null));
    expect(html).toContain("border-l-[#e03131]");
    expect(html).not.toContain("#f0a020");
  });

  test("a successful resend stays quiet: muted, no rail", () => {
    const html = render(resendVerificationOutcome(200));
    expect(text(html)).toContain("Verification email sent again");
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("border-l-2");
  });
});
