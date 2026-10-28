import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { bootstrapAccount, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

/**
 * `sendText` — the conversation composer's free-text send.
 *
 * It sits behind the same door discipline as `sendTemplateTest`: ownership is
 * decided by the control plane, the limiter key is the tenant's shared one, and
 * every send leaves an outbound row. What is new is the 24-hour window, which
 * Meta enforces and the gateway reports as `window_closed`.
 */

/** The Meta customer id the send is answered with. Deliberately not the typed number. */
const META_WA_ID = "34600000099";
const TYPED_TO = "34600000011";

beforeEach(async () => {
  await bootstrapAccount();
});

afterEach(async () => {
  delete (env as { SEND_RATE_LIMITER?: RateLimit }).SEND_RATE_LIMITER;
  vi.restoreAllMocks();
  await reset();
});

function makeRpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    wabaId: TEST_WABA_ID,
    phoneNumberId: "PNID1",
    to: TYPED_TO,
    text: "Hello from the inbox",
    ...overrides,
  } as Parameters<GatewayRPC["sendText"]>[0];
}

/** A Graph mock that accepts the send and answers with Meta's own customer id. */
function mockSendOk() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        contacts: [{ input: TYPED_TO, wa_id: META_WA_ID }],
        messages: [{ id: "wamid.TEXT_SENT" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

/** A Graph mock that refuses with one of Meta's own error envelopes. */
function mockSendError(code: number | null, message: string, status = 400) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ error: { ...(code === null ? {} : { code }), message, type: "OAuthException" } }),
      { status, headers: { "content-type": "application/json" } },
    ),
  );
}

describe("GatewayRPC.sendText", () => {
  it("sends a plain text message from the requested phone and logs it under Meta's customer id", async () => {
    // The thread parity invariant: a composer send must land in the same
    // conversation a template send does, keyed by the wa_id Meta answered with,
    // not by whatever number the operator typed.
    const fetchSpy = mockSendOk();
    const result = await makeRpc().sendText(input(), TEST_ACCOUNT_ID);
    expect(result).toEqual({ ok: true, messageId: "wamid.TEXT_SENT" });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/PNID1\/messages$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      to: TYPED_TO,
      type: "text",
      text: { body: "Hello from the inbox", preview_url: false },
    });

    const rows = await makeRpc().listOutbound({ wabaId: TEST_WABA_ID }, TEST_ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "sent",
      transport_message_id: "wamid.TEXT_SENT",
      phone_number_id: "PNID1",
      recipient: TYPED_TO,
    });

    const thread = await makeRpc().getConversation({ wabaId: TEST_WABA_ID, waId: META_WA_ID }, TEST_ACCOUNT_ID);
    expect(thread.items.map((m) => [m.id, m.direction, m.text])).toEqual([
      ["wamid.TEXT_SENT", "out", "Hello from the inbox"],
    ]);
  });

  it("accepts a body of exactly 4096 characters and refuses one more", async () => {
    const fetchSpy = mockSendOk();
    await expect(makeRpc().sendText(input({ text: "x".repeat(4096) }), TEST_ACCOUNT_ID)).resolves.toMatchObject({
      ok: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockClear();
    const error = await makeRpc()
      .sendText(input({ text: "x".repeat(4097) }), TEST_ACCOUNT_ID)
      .then(() => null, (reason) => reason);
    expect(String(error?.message)).toMatch(/1-4096/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed for a WABA the account does not own, without calling Meta", async () => {
    // Tenant isolation: ownership is decided by the control plane before any
    // credential is opened.
    const fetchSpy = mockSendOk();
    const error = await makeRpc()
      .sendText(input(), "other-account")
      .then(() => null, (reason) => reason);
    expect(String(error?.message ?? error)).toMatch(/not owned|does not exist/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed for a pending or failed WABA, without calling Meta", async () => {
    await runInDurableObject(getControlPlaneStub(env), async (cp) => {
      await cp.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_TEXT_PENDING",
        metaAccessToken: "pending-token",
        provisioningStatus: "pending",
        phones: [{ phoneNumberId: "PNID_TEXT_PENDING" }],
      });
    });
    const fetchSpy = mockSendOk();
    const error = await makeRpc()
      .sendText(input({ wabaId: "WABA_TEXT_PENDING", phoneNumberId: "PNID_TEXT_PENDING" }), TEST_ACCOUNT_ID)
      .then(() => null, (reason) => reason);
    expect(String(error?.message ?? error)).toMatch(/not owned/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns no_phone for a phone that is not registered on the WABA", async () => {
    const fetchSpy = mockSendOk();
    const result = await makeRpc().sendText(input({ phoneNumberId: "PNID_UNKNOWN" }), TEST_ACCOUNT_ID);
    expect(result).toMatchObject({ ok: false, code: "no_phone" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses on the SHARED rate-limit key before Meta is called", async () => {
    // Same key as the template send and the HTTP middleware: a console session
    // must never hold a bigger send budget than a stolen API key.
    const limit = vi.fn(async () => ({ success: false }));
    (env as { SEND_RATE_LIMITER?: RateLimit }).SEND_RATE_LIMITER = { limit };
    const fetchSpy = mockSendOk();

    const result = await makeRpc().sendText(input(), TEST_ACCOUNT_ID);
    expect(result).toEqual({ ok: false, code: "rate_limited", detail: null });
    expect(limit).toHaveBeenCalledWith({ key: `${TEST_ACCOUNT_ID}:${TEST_WABA_ID}` });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps Meta's 131047 to window_closed and logs the refused send as failed", async () => {
    // The one refusal the composer must name: the window closed, so only a
    // template can reach this customer. Meta's own sentence rides along.
    mockSendError(131047, "Message failed to send because more than 24 hours have passed");
    const result = await makeRpc().sendText(input(), TEST_ACCOUNT_ID);
    expect(result).toEqual({
      ok: false,
      code: "window_closed",
      detail: "Message failed to send because more than 24 hours have passed",
    });

    const rows = await makeRpc().listOutbound({ wabaId: TEST_WABA_ID }, TEST_ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", recipient: TYPED_TO, phone_number_id: "PNID1" });
  });

  it("maps the test-number allowlist and degrades any other code to graph", async () => {
    const cases = [
      { code: 131030, expected: "recipient_not_allowlisted" },
      { code: 999999, expected: "graph" },
    ] as const;
    for (const { code, expected } of cases) {
      vi.restoreAllMocks();
      mockSendError(code, `meta says ${code}`);
      const result = await makeRpc().sendText(input(), TEST_ACCOUNT_ID);
      expect(result, String(code)).toEqual({ ok: false, code: expected, detail: `meta says ${code}` });
    }
  });

  it("falls back to the HTTP status when Meta sends no message text", async () => {
    mockSendError(null, "", 502);
    const result = await makeRpc().sendText(input(), TEST_ACCOUNT_ID);
    expect(result).toEqual({ ok: false, code: "graph", detail: "HTTP 502" });
  });

  it("throws on malformed input, because only a regressed console can produce it", async () => {
    const fetchSpy = mockSendOk();
    for (const bad of [{ to: "not-a-number" }, { text: "" }]) {
      const error = await makeRpc()
        .sendText(input(bad), TEST_ACCOUNT_ID)
        .then(() => null, (reason) => reason);
      expect(error, JSON.stringify(bad)).not.toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
