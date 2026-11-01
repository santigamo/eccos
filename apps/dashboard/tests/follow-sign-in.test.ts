/**
 * An event handler's server-function call on an expired session (eccos-myfq):
 * the gate's redirect is followed, not shown as an error or left unhandled.
 */

import { describe, expect, test } from "bun:test";
import { redirect } from "@tanstack/react-router";
import { followSignIn, watchUnhandledSignIn } from "../src/lib/follow-sign-in";
import { submitRetryFailed } from "../src/lib/retry-window";
import { serverFnSignIn } from "../src/auth/page-gate";

const ORIGIN = "https://app.eccos.chat";

/** What the client fetcher throws for the gate's 401 (see tests/page-gate.test.ts). */
async function gateRedirect() {
  const res = serverFnSignIn(
    new Request(`${ORIGIN}/_serverFn/abc`, { headers: { referer: `${ORIGIN}/deliveries` } }),
  );
  return redirect(await res.json());
}

describe("followSignIn", () => {
  test("follows the gate's redirect with a full load", async () => {
    const went: string[] = [];
    expect(followSignIn(await gateRedirect(), (href) => went.push(href))).toBe(true);
    expect(went).toEqual(["/signin?redirect=%2Fdeliveries"]);
  });

  test("leaves any other error to the caller", () => {
    const went: string[] = [];
    expect(followSignIn(new Error("network"), (href) => went.push(href))).toBe(false);
    expect(went).toEqual([]);
  });
});

describe("watchUnhandledSignIn", () => {
  function fakeWindow() {
    const listeners = new Set<(event: PromiseRejectionEvent) => void>();
    return {
      win: {
        addEventListener: (_: string, fn: (event: PromiseRejectionEvent) => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: (event: PromiseRejectionEvent) => void) => listeners.delete(fn),
      } as unknown as Window,
      reject(reason: unknown) {
        let prevented = false;
        const event = { reason, preventDefault: () => {
          prevented = true;
        } } as unknown as PromiseRejectionEvent;
        for (const fn of listeners) fn(event);
        return prevented;
      },
    };
  }

  test("follows an uncaught sign-in redirect and leaves other rejections alone", async () => {
    const w = fakeWindow();
    const went: string[] = [];
    const stop = watchUnhandledSignIn(w.win, (href) => went.push(href));
    expect(w.reject(await gateRedirect())).toBe(true);
    expect(w.reject(new Error("boom"))).toBe(false);
    expect(went).toEqual(["/signin?redirect=%2Fdeliveries"]);
    stop();
    expect(w.reject(await gateRedirect())).toBe(false);
  });
});

test("a helper that turns throws into notices lets the redirect through", async () => {
  const thrown = await gateRedirect();
  const input = { wabaId: "waba-a", fromInput: "2026-10-19T08:00", toInput: "2026-10-26T10:30" };
  await expect(submitRetryFailed(input, () => Promise.reject(thrown))).rejects.toBe(thrown);
});
