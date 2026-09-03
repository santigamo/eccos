import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Settings page's stages (`routes/settings.tsx`), rendered through the
 * router-free `SettingsView` — the route component itself reads three router
 * hooks, and mocking `@tanstack/react-router` would be a process-global
 * registration this suite must not take on (see helpers/server-fn-mocks.ts).
 *
 * Only the two WABA-LESS stages are rendered here: `SubscriberForm` calls
 * `useRouter()`, so the active stage genuinely needs a router. Those two are
 * also the ones with something to prove — they are where the token panel could
 * be hidden by an early return.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { SettingsView } = await import("../src/routes/settings");

const CONFIG_FAILURE = {
  ok: false as const,
  kind: "unreachable" as const,
  error: 'Account "account-a" has no registered WABAs',
};

describe("SettingsView", () => {
  test("with no WABA at all, the token panel is still there", () => {
    // INVARIANT, and the load-bearing one: an account with zero WABAs is
    // exactly the state this panel exists to fix (Meta's Cloud API test number
    // is attached by paste, because Embedded Signup onboards businesses and
    // never offers it). The page used to early-return a failure card in this
    // state, which hid the only form that could get the operator out of it.
    const html = renderToStaticMarkup(
      <SettingsView result={CONFIG_FAILURE} hasWaba={false} isActive={false} />,
    );
    expect(html).toContain("Attach by token");
    expect(html).toContain("Meta access token");
  });

  test("no WABA is a note, not a failure card blaming the gateway", () => {
    // Data rule 7: only `unreachable` may say the gateway is unreachable, and
    // nothing failed here — the subscriber config simply has no scope yet. The
    // empty state has structure (machine-voice label + one sentence), not a
    // lone muted line.
    const html = renderToStaticMarkup(
      <SettingsView result={CONFIG_FAILURE} hasWaba={false} isActive={false} />,
    );
    expect(html).toContain("No number yet");
    expect(html).toContain("A forwarding target belongs to a WhatsApp number");
    expect(html).not.toContain("Gateway unreachable");
    expect(html).not.toContain("has no registered WABAs");
  });

  test("a real subscriber failure still gets its failure card, and keeps the panel", () => {
    // INVARIANT: scoping the failure to the section it belongs to must not
    // swallow it. A WABA exists, the read failed, so the operator is told —
    // and the token panel below still renders, because it never depended on
    // that read.
    const html = renderToStaticMarkup(
      <SettingsView
        result={{ ok: false, kind: "unreachable", error: "Durable Object unreachable" }}
        hasWaba
        isActive={false}
        selectedWabaId="waba-a"
      />,
    );
    expect(html).toContain("Gateway unreachable");
    expect(html).toContain("Attach by token");
  });

  test("re-subscribe stays behind an active WABA", () => {
    // Unchanged rule: for a WABA still awaiting its phone number the webhooks
    // ARE subscribed and the reconciler needs a primary phone, so the action
    // would mean nothing.
    const html = renderToStaticMarkup(
      <SettingsView result={CONFIG_FAILURE} hasWaba={false} isActive={false} />,
    );
    expect(html).not.toContain("Re-subscribe");
  });
});
