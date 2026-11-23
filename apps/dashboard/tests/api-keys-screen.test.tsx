import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/** The API keys page (`routes/api-keys.tsx`), rendered through the router-free `ApiKeysView`. */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { ApiKeysView } = await import("../src/routes/api-keys");
const { IssuedKeyNotice, SendSnippet } = await import("../src/components/dashboard/api-keys");

const CREATED = Date.UTC(2026, 10, 9, 8, 46, 10);
const keys = {
  ok: true as const,
  data: [
    { keyId: "key_live", label: "prod", createdAt: CREATED, revokedAt: null },
    { keyId: "key_old", label: null, createdAt: CREATED - 86_400_000, revokedAt: CREATED },
  ],
};

describe("ApiKeysView, owner or admin", () => {
  const html = renderToStaticMarkup(
    <ApiKeysView canAdminister keys={keys} wabaId="1234567890" gatewayOrigin="https://api.eccos.chat" />,
  );

  test("the create form, the list, and the send snippet", () => {
    expect(html).toContain("API keys");
    expect(html).toContain("Create key");
    expect(html).toContain("key_live");
    expect(html).toContain("Revoke");
    expect(html).toContain("Revoked");
    expect(html).toContain("https://api.eccos.chat/v1/wabas/1234567890/messages");
    expect(html).toContain("Authorization: Bearer &lt;API_KEY&gt;");
  });

  test("the page heading names the page once; the sections are Keys and Send a message", () => {
    expect(html.match(/API keys/g)).toHaveLength(1);
    expect(html).toMatch(/<h2[^>]*>Keys<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Send a message<\/h2>/);
  });

  test("keys are a table: Key (label over its id), Created, and the action column", () => {
    expect(html).toContain("<table");
    expect(html).toMatch(/<th[^>]*>Key<\/th>/);
    expect(html).toMatch(/<th[^>]*>Created<\/th>/);
    expect(html).toMatch(/font-medium text-foreground" title="prod">prod<\/span><span class="[^"]*font-mono[^"]*">key_live</);
  });

  test("the label input is not offered to a password manager", () => {
    expect(html).toContain('data-1p-ignore="true"');
    expect(html).toContain('autoComplete="off"');
  });

  test("key dates read as the UTC day, with the exact instant on hover", () => {
    expect(html).toContain('<time dateTime="2026-11-09T08:46:10.000Z" title="2026-11-09 08:46:10 UTC"');
    expect(html).toContain(">2026-11-09</time>");
    expect(html).not.toContain(">2026-11-09 08:46:10 UTC<");
  });

  test("the send snippet keeps placeholders without a gateway URL or a WABA", () => {
    const bare = renderToStaticMarkup(<ApiKeysView canAdminister keys={{ ok: true, data: [] }} />);
    expect(bare).toContain("&lt;GATEWAY_URL&gt;/v1/wabas/&lt;WABA_ID&gt;/messages");
    expect(bare).toContain("No keys yet");
    // Conversations sends with no key, so the empty state must not say otherwise.
    expect(bare).toContain("Conversations in this console works without it");
    expect(bare).toContain('href="https://docs.eccos.chat/sending-messages"');
  });
});

const refused = { ok: false as const, kind: "forbidden" as const, reason: "missing-permission" as const, error: "missing" };

describe("ApiKeysView, without administer", () => {
  test("the refused read is not rendered; one note names who to ask, with no control to act with", () => {
    const html = renderToStaticMarkup(<ApiKeysView canAdminister={false} keys={refused} />);
    expect(html).toContain("Owner or admin only");
    expect(html).toContain("Ask one of them for a key.");
    expect(html).not.toContain("Create key");
    expect(html).not.toContain("Revoke");
    expect(html).not.toContain("Bearer");
  });

  test("a refusal from the server on a stale root flag reads through failureCopy, with no controls", () => {
    const html = renderToStaticMarkup(<ApiKeysView canAdminister keys={refused} />);
    expect(html).toContain("Not available to your role");
    expect(html).not.toContain("Create key");
    expect(html).not.toContain("Bearer");
  });
});

describe("ApiKeysView when the root read failed", () => {
  test("renders that failure, never a role refusal", () => {
    const html = renderToStaticMarkup(
      <ApiKeysView
        rootFailure={{ ok: false, kind: "unreachable", error: "fetch failed" }}
        canAdminister={false}
        keys={{ ok: true, data: [] }}
      />,
    );
    expect(html).toContain("Gateway unreachable");
    expect(html).not.toContain("Owner or admin only");
    expect(html).not.toContain("Create key");
  });
});

test("a long key label truncates inside its cell instead of pushing Created and Revoke out", () => {
  const long = { ok: true as const, data: [{ keyId: "key_long", label: "x".repeat(200), createdAt: CREATED, revokedAt: null }] };
  const html = renderToStaticMarkup(<ApiKeysView canAdminister keys={long} />);
  expect(html).toMatch(/<td class="max-w-0 [^"]*"><span class="block truncate/);
});

describe("IssuedKeyNotice", () => {
  test("a new key is shown once, with a copy control and the warning", () => {
    const html = renderToStaticMarkup(
      <IssuedKeyNotice issued={{ keyId: "key_new", apiKey: "ek_secret" }} onDone={() => {}} />,
    );
    expect(html).toContain("ek_secret");
    expect(html).toContain("Copy");
    expect(html).toContain("You won&#x27;t see this key again");
  });

  test("the send example carries a new key once there is one", () => {
    const html = renderToStaticMarkup(
      <SendSnippet wabaId="waba-a" gatewayOrigin="https://gw.example" apiKey="ek_secret" />,
    );
    expect(html).toContain("https://gw.example/v1/wabas/waba-a/messages");
    expect(html).toContain("Authorization: Bearer ek_secret");
    expect(html).toContain("Read the API guide");
  });
});
