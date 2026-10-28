import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What is left of the Settings page (`routes/settings.tsx`), rendered through
 * the router-free `SettingsView`.
 *
 * The page used to carry three things it no longer does — the forwarding
 * target, the re-subscribe handshake and the pasted-token panel. The first two
 * are on /webhooks beside the callback URL they belong to
 * (`tests/webhooks-screen.test.tsx`); the token panel moved to an unlisted
 * route, and its invariants moved with it
 * (`tests/attach-token-screen.test.tsx`). These tests hold the page to what
 * survived, and — deliberately — to the absence of what left: a panel that
 * quietly comes back here is the decision being undone.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { SettingsView } = await import("../src/routes/settings");
const { IssuedKeyNotice } = await import("../src/components/dashboard/api-keys");
const { ConversationRetentionPanel, RETENTION_CHOICES } = await import(
  "../src/components/dashboard/conversation-retention"
);

describe("SettingsView", () => {
  const html = renderToStaticMarkup(<SettingsView accountId="account-a" />);

  test("shows the account id, which is what an operator comes here for", () => {
    expect(html).toContain("Workspace");
    expect(html).toContain("Account ID");
    expect(html).toContain("account-a");
  });

  test("the panels that moved are gone, and did not leave a stub behind", () => {
    // INVARIANT. Each of these strings is the visible trace of a panel that now
    // lives elsewhere; finding one here means two pages own the same control.
    expect(html).not.toContain("Attach by token");
    expect(html).not.toContain("Meta access token");
    expect(html).not.toContain("Forwarding target");
    expect(html).not.toContain("Forwarding URL");
    expect(html).not.toContain("Re-subscribe");
  });

  test("no pointer to the unlisted token route survives here", () => {
    // The old "no number yet" note said a number could be attached "by token
    // below". Both the note and the panel are gone; a link would put the route
    // back in the interface, which is precisely what unlisted means it must not
    // be (routes/numbers_.attach-token.tsx).
    expect(html).not.toContain("attach-token");
  });

  test("nothing here needs a WABA, so nothing here can fail for want of one", () => {
    // The page keeps `requires: "none"` on the Workspace panel's own merits,
    // and it no longer reads anything WABA-scoped — so there is no failure card
    // and no empty note to render. With no account resolved yet it renders the
    // page chrome and stops, rather than blaming the gateway for a scope that
    // simply does not exist yet (data rule 7).
    const empty = renderToStaticMarkup(<SettingsView />);
    expect(empty).toContain("Settings");
    expect(empty).not.toContain("Gateway unreachable");
    expect(empty).not.toContain("Account ID");
  });
});

describe("API keys panel", () => {
  const keys = {
    ok: true as const,
    data: [
      { keyId: "key_live", label: "prod", createdAt: 1, revokedAt: null },
      { keyId: "key_old", label: null, createdAt: 0, revokedAt: 2 },
    ],
  };

  test("an administrator gets the create form, the list, and the send snippet", () => {
    const html = renderToStaticMarkup(
      <SettingsView accountId="account-a" keys={keys} wabaId="1234567890" />,
    );
    expect(html).toContain("API keys");
    expect(html).toContain("Create key");
    expect(html).toContain("key_live");
    expect(html).toContain("Revoke");
    expect(html).toContain("Revoked");
    expect(html).toContain("https://api.eccos.chat/v1/wabas/1234567890/messages");
    expect(html).toContain("Authorization: Bearer &lt;API_KEY&gt;");
  });

  test("a role without administer sees the refusal, and no control to act with", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        accountId="account-a"
        keys={{
          ok: false,
          kind: "forbidden",
          reason: "missing-permission",
          error: 'missing "administer" permission in this organization',
        }}
      />,
    );
    expect(html).toContain("API keys");
    expect(html).toContain("Not available to your role");
    expect(html).not.toContain("Create key");
    expect(html).not.toContain("Revoke");
    expect(html).not.toContain("Bearer");
  });

  test("with no WABA yet the snippet keeps the placeholder", () => {
    const html = renderToStaticMarkup(
      <SettingsView accountId="account-a" keys={{ ok: true, data: [] }} />,
    );
    expect(html).toContain("/v1/wabas/&lt;WABA_ID&gt;/messages");
    expect(html).toContain("No keys yet");
  });

  test("a new key is shown once, with a copy control and the warning", () => {
    const html = renderToStaticMarkup(
      <IssuedKeyNotice issued={{ keyId: "key_new", apiKey: "ek_secret" }} onDone={() => {}} />,
    );
    expect(html).toContain("ek_secret");
    expect(html).toContain("Copy");
    expect(html).toContain("You won&#x27;t see this key again");
  });
});

describe("Conversation history control (Settings)", () => {
  test("renders the control with keep-forever as the default and the three windows", () => {
    const html = renderToStaticMarkup(
      <SettingsView accountId="account-a" keys={{ ok: true, data: [] }} retention={{ ok: true, data: null }} />,
    );
    expect(html).toContain("Conversation history");
    expect(html).toContain("The short buffer used for forwarding is separate");
    expect(html).toContain("Keep conversations");
    expect(html).toContain("Keep forever");
    expect(RETENTION_CHOICES.map((choice) => choice.label)).toEqual([
      "Keep forever",
      "Delete after 30 days",
      "Delete after 90 days",
      "Delete after 365 days",
    ]);
  });

  test("the control is quiet until a window is chosen, then says what it deletes", () => {
    const forever = renderToStaticMarkup(
      <ConversationRetentionPanel retention={{ ok: true, data: null }} />,
    );
    expect(forever).not.toContain("Older conversations and contacts are deleted");
    expect(forever).toContain("disabled");

    const windowed = renderToStaticMarkup(
      <ConversationRetentionPanel retention={{ ok: true, data: 90 }} />,
    );
    expect(windowed).toContain("Delete after 90 days");
    expect(windowed).toContain("Older conversations and contacts are deleted");
  });

  test("a role without administer sees the refusal copy, not the control", () => {
    const html = renderToStaticMarkup(
      <ConversationRetentionPanel
        retention={{
          ok: false,
          kind: "forbidden",
          reason: "missing-permission",
          error: 'missing "administer" permission in this organization',
        }}
      />,
    );
    expect(html).toContain("Conversation history");
    expect(html).toContain("Not available to your role");
    expect(html).not.toContain("Save");
    expect(html).not.toContain("Keep conversations");
  });

  test("the copy keeps to plain sentences and no em dash", () => {
    const html = renderToStaticMarkup(
      <ConversationRetentionPanel retention={{ ok: true, data: 30 }} />,
    );
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");
  });
});
