import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubscriberConfig } from "@eccos/gateway-contract";

/**
 * The Webhooks page (`routes/webhooks.tsx`) — its panels, and the two readings
 * behind its facts strip.
 *
 * WHAT THESE TESTS CANNOT REACH. This suite is `bun test` with
 * `renderToStaticMarkup` and no DOM (deliberately — see
 * `tests/masthead-breadcrumb.test.tsx`). So the page itself is not rendered:
 * its facts strip is built out of router `Link`s, which need a RouterProvider.
 * What is covered instead is everything that decides what those cells SAY
 * (`lib/forwarding.ts`, pure) plus every panel below the strip, each of which
 * is prop-driven for exactly this reason.
 *
 * Not covered here, and not coverable without a DOM: that `Generate` fills the
 * field, that `Show` reveals it, that the confirm appears after a click, and
 * that Save clears the box. The components those states belong to are exported
 * and rendered directly with the state they would be in, which pins the rules
 * (`Show` exists only while unsaved) without pretending the interaction was
 * exercised.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { ForwardingTargetPanel, RemoveTargetConfirm, SigningSecretField } = await import(
  "../src/components/dashboard/forwarding-target"
);
const { FromMetaPanel, ReceiverReference } = await import("../src/routes/webhooks");
const { forwardingTag, readLastForward } = await import("../src/lib/forwarding");

const CONFIGURED: SubscriberConfig = {
  url: "https://receiver.example/hook",
  hasSecret: true,
  lastForward: null,
};

const EMPTY: SubscriberConfig = { url: null, hasSecret: false, lastForward: null };

function stripRounded(html: string): string {
  // `rounded-(--frame-radius)` and friends resolve to 0 (app.css pins every
  // `--radius-*` to 0), so token-based utilities are square already.
  return html
    .replace(/rounded-none/g, "")
    .replace(/rounded-\([^)]*\)/g, "")
    .replace(/rounded-\[[^\]]*\]/g, "");
}

describe("forwardingTag", () => {
  test("reports configuration, and offers nothing to toggle", () => {
    // Eccos has no pause semantics. A tag that reads as a switch but is not one
    // lies about the interaction contract, so this is a fact with two values
    // and no third "paused" state to invent.
    expect(forwardingTag(CONFIGURED)).toBe("forwarding");
    expect(forwardingTag(EMPTY)).toBe("no target");
  });
});

describe("readLastForward", () => {
  test("a row that has not finished reports when it was QUEUED", () => {
    // THE RULE THIS MODULE EXISTS FOR. `finishedAt: null` means the row has not
    // finished — queued, held for want of a target, or between retries — and
    // its only timestamp is when the batch arrived. Falling back to `createdAt`
    // as a completion time turns "queued 15 days ago" into "delivered 15 days
    // ago", which is the confusion the column was added to end.
    const reading = readLastForward({
      status: "pending",
      attempts: 0,
      createdAt: 1_700_000_000_000,
      finishedAt: null,
      lastError: null,
    });
    expect(reading).toEqual({
      status: "pending",
      moment: "queued",
      at: 1_700_000_000_000,
      attempts: 0,
      lastError: null,
    });
  });

  test("a finished row reports the terminal moment, not the arrival", () => {
    const reading = readLastForward({
      status: "failed",
      attempts: 6,
      createdAt: 1_700_000_000_000,
      finishedAt: 1_700_000_600_000,
      lastError: "subscriber returned 502",
    });
    expect(reading?.moment).toBe("finished");
    expect(reading?.at).toBe(1_700_000_600_000);
    expect(reading?.lastError).toBe("subscriber returned 502");
  });

  test("nothing enqueued yet is null, not a zeroed row", () => {
    expect(readLastForward(null)).toBeNull();
  });
});

describe("ForwardingTargetPanel", () => {
  const configured = renderToStaticMarkup(
    <ForwardingTargetPanel config={CONFIGURED} wabaId="waba-a" />,
  );
  const empty = renderToStaticMarkup(<ForwardingTargetPanel config={EMPTY} />);

  test("pre-fills the stored URL and offers to remove it", () => {
    expect(configured).toContain('value="https://receiver.example/hook"');
    expect(configured).toContain("Remove target");
  });

  test("with no target it is a structured empty state, and the form is the action", () => {
    // Data rule 6: a machine-voice label plus one sentence saying what will
    // appear — never a lone muted line, and no action of its own, because the
    // form directly below IS the action. The sentence is only honest because
    // the gateway now HOLDS the queue while no target exists.
    expect(empty).toContain("No forwarding target");
    expect(empty).toContain("Events are queued, not attempted");
    // Nothing to remove, so no dead control (data rule 5).
    expect(empty).not.toContain("Remove target");
  });

  test("the empty state says the hold is bounded, not an archive", () => {
    // `pruneExpired` DELETES a held row past the content window, so a promise
    // that events are simply "not lost" would outlive the storage backing it.
    // This assertion exists so that copy cannot drift back.
    expect(empty).toContain("expire with the retention window");
    expect(empty).not.toContain("not lost");
  });

  test("the secret is write-only, and says so in the functional register", () => {
    expect(configured).toContain('id="subscriber-secret"');
    expect(configured).toContain('type="password"');
    expect(configured).toContain("Write-only");
    expect(configured).toContain("deliveries");
    // The recovery path is rotation, never a reveal — the stored value never
    // comes back out of the gateway (docs/threat-model.md).
    expect(configured).toContain("set a new one here and in your receiver");
  });

  test("Save is the page's one primary; everything else is a ghost", () => {
    // The brand glow marks exactly one action per view. `Remove target` and
    // `Generate` are ghosts: `--ghost-fill` under a `--line-strong` edge.
    // `shadow-(--caustic)` exactly once: the primary variant also carries
    // `hover:shadow-(--caustic-hi)`, so a bare "--caustic" count would read 2
    // for one button.
    expect(configured.match(/shadow-\(--caustic\)/g)?.length).toBe(1);
    expect(configured).toContain("Save");
    expect(configured).toContain("border-(--line-strong)");
    expect(configured).toContain("bg-(--ghost-fill)");
  });

  test("keeps the two laws: square corners, machine-voice labels", () => {
    expect(stripRounded(configured)).not.toMatch(/rounded-/);
    expect(configured).toContain(
      "text-[11px] font-medium tracking-wider text-muted-foreground uppercase",
    );
  });

  test("no confirm and no notice at rest", () => {
    // Both are answers to something that has happened; rendering either at rest
    // would announce an event nobody triggered.
    expect(configured).not.toContain("Remove the forwarding target?");
    expect(configured).not.toContain("Saved.");
  });
});

describe("SigningSecretField", () => {
  const empty = renderToStaticMarkup(
    <SigningSecretField
      value=""
      revealed={false}
      hasStoredSecret
      onChange={() => {}}
      onGenerate={() => {}}
      onToggleReveal={() => {}}
    />,
  );
  const unsaved = renderToStaticMarkup(
    <SigningSecretField
      value="deadbeef"
      revealed={false}
      hasStoredSecret
      onChange={() => {}}
      onGenerate={() => {}}
      onToggleReveal={() => {}}
    />,
  );
  const shown = renderToStaticMarkup(
    <SigningSecretField
      value="deadbeef"
      revealed
      hasStoredSecret
      onChange={() => {}}
      onGenerate={() => {}}
      onToggleReveal={() => {}}
    />,
  );

  test("show/hide exists ONLY while an unsaved value is in the field", () => {
    // INVARIANT. The console may reveal what it is still holding and nothing
    // else: after a save the field is cleared and `hasSecret` is the only trace
    // left, so a reveal control on an empty box would promise something no read
    // can deliver.
    expect(empty).not.toContain(">Show<");
    expect(unsaved).toContain(">Show<");
    expect(shown).toContain(">Hide<");
  });

  test("revealing only unmasks a value that has not been saved", () => {
    expect(shown).toContain('type="text"');
    expect(unsaved).toContain('type="password"');
    // Even asked to reveal, an empty field stays a password field — the flag
    // cannot outlive the value it was set for.
    const revealedButEmpty = renderToStaticMarkup(
      <SigningSecretField
        value=""
        revealed
        hasStoredSecret
        onChange={() => {}}
        onGenerate={() => {}}
        onToggleReveal={() => {}}
      />,
    );
    expect(revealedButEmpty).toContain('type="password"');
  });

  test("Generate is always there, and the placeholder says what blank means", () => {
    expect(empty).toContain("Generate");
    expect(empty).toContain("leave blank to keep the stored secret");
    const none = renderToStaticMarkup(
      <SigningSecretField
        value=""
        revealed={false}
        hasStoredSecret={false}
        onChange={() => {}}
        onGenerate={() => {}}
        onToggleReveal={() => {}}
      />,
    );
    expect(none).toContain("no secret set");
  });
});

describe("RemoveTargetConfirm", () => {
  const html = renderToStaticMarkup(
    <RemoveTargetConfirm busy={false} onCancel={() => {}} onConfirm={() => {}} />,
  );

  test("says what removal costs, which is not what an operator fears", () => {
    // The queue is HELD while no target is configured, so removing one does not
    // burn attempts or fail rows. Saying so is the difference between a confirm
    // that informs and one that only delays.
    expect(html).toContain("events wait in the queue");
    expect(html).toContain("The signing secret is kept.");
    expect(html).toContain("Cancel");
  });

  test("confirming is a ghost, not a second primary", () => {
    expect(html).not.toContain("--caustic");
    expect(html).toContain("border-(--line-strong)");
  });
});

describe("FromMetaPanel", () => {
  const html = renderToStaticMarkup(
    <FromMetaPanel
      callbackUrl="https://gateway.example/webhook/waba-a"
      connectedAt="2026-09-01T10:00:00.000Z"
      wabaId="waba-a"
    />,
  );

  test("shows the other leg of the plumbing, with the handshake beside it", () => {
    // Re-subscribe moved here from /settings: it belongs next to the callback
    // URL it re-subscribes, and the page then shows both directions —
    // Meta → Eccos here, Eccos → your receiver above.
    expect(html).toContain("From Meta");
    expect(html).toContain("Callback URL");
    expect(html).toContain("https://gateway.example/webhook/waba-a");
    expect(html).toContain("Connected at");
    expect(html).toContain("2026-09-01T10:00:00.000Z");
    expect(html).toContain("Re-subscribe");
  });

  test("a missing callback URL is an em-dash, not a blank row", () => {
    const unknown = renderToStaticMarkup(
      <FromMetaPanel callbackUrl={null} connectedAt={null} />,
    );
    expect(unknown).toContain("—");
  });

  test("its action is a ghost: the one primary belongs to Save", () => {
    expect(html).not.toContain("--caustic");
    expect(html).toContain("border-(--line-strong)");
    expect(stripRounded(html)).not.toMatch(/rounded-/);
  });
});

describe("ReceiverReference", () => {
  const html = renderToStaticMarkup(<ReceiverReference />);

  test("states the forwarding contract as the gateway actually implements it", () => {
    // Every line here was read out of `apps/gateway/src/gateway.ts` and
    // `packages/core/src/signature.ts`, not out of a design document. If the
    // forwarder changes, this panel is wrong until it changes too.
    expect(html).toContain("POST · content-type: application/json");
    expect(html).toContain('{ &quot;events&quot;: [ … ] }');
    expect(html).toContain("x-eccos-signature");
    expect(html).toContain("sha256=&lt;HMAC-SHA256 hex of the raw body&gt;");
    expect(html).toContain("x-webhook-event");
    expect(html).toContain("the first event&#x27;s type");
    expect(html).toContain("x-idempotency-key");
    expect(html).toContain("SHA-256 hex of the raw body");
    expect(html).toContain("6 attempts · 5s to 1h, ×5 each time, ±10% jitter");
    expect(html).toContain("5s per attempt");
    expect(html).toContain("refused");
    expect(html).toContain("any 2xx");
  });

  test("says the signature is conditional, because it is", () => {
    // `forwardOne` only sets the header when a secret is stored. A receiver
    // told to verify unconditionally would reject every unsigned delivery it
    // was configured to accept.
    expect(html).toContain("Sent only while a signing secret is set.");
  });

  test("is reference, not state: quiet, square, and free of controls", () => {
    expect(html).not.toContain("<button");
    expect(html).not.toContain("--caustic");
    expect(stripRounded(html)).not.toMatch(/rounded-/);
  });
});
