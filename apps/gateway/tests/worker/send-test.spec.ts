import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { bootstrapAccount, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

/**
 * `sendTemplateTest` — the console's one send surface (the "Send test" sheet).
 *
 * The whole point of these tests is that the console must never be a softer
 * send surface than the public HTTP API: same fail-closed ownership rules, same
 * rate-limit budget, same outbound evidence trail.
 */

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
    to: "34600000011",
    templateName: "hello_world",
    languageCode: "en_US",
    ...overrides,
  } as Parameters<GatewayRPC["sendTemplateTest"]>[0];
}

/** A Graph mock that answers any `/messages` POST with a message id. */
function mockSendOk() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ messages: [{ id: "wamid.SENT" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
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

describe("GatewayRPC.sendTemplateTest", () => {
  it("sends the template from the requested phone and logs it to /outbound", async () => {
    // The evidence-trail parity invariant: a console send has to land in the
    // same `outbound_messages` table an API send does, carrying its
    // phone_number_id — that log is both the console's evidence link (data rule
    // 2) and the row that retention and erasure govern.
    const fetchSpy = mockSendOk();
    const result = await makeRpc().sendTemplateTest(input({ bodyParams: ["Ada"] }), TEST_ACCOUNT_ID);
    expect(result).toEqual({ ok: true, messageId: "wamid.SENT" });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/PNID1\/messages$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      to: "34600000011",
      type: "template",
      template: {
        name: "hello_world",
        language: { code: "en_US" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Ada" }] }],
      },
    });

    const rows = await makeRpc().listOutbound({ wabaId: TEST_WABA_ID }, TEST_ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "sent",
      transport_message_id: "wamid.SENT",
      phone_number_id: "PNID1",
      recipient: "34600000011",
    });
  });

  it("omits the components array entirely for a zero-parameter template", async () => {
    // `hello_world` — the App Review screencast template. Meta rejects an empty
    // `components` array, so the body must simply not carry one. The same holds
    // when there are no button params either: neither kind of fill means NO
    // components array at all.
    const fetchSpy = mockSendOk();
    await makeRpc().sendTemplateTest(input(), TEST_ACCOUNT_ID);
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(body.template).not.toHaveProperty("components");
  });

  it("emits one lowercase button component per button param, after the body", async () => {
    // SEND-side orthography is lower case: `type: "button"`, `sub_type:
    // "url"`, and the index is a STRING — the same lowercase family as the
    // body component. (UPPER is the CREATE-side Graph shape.) Each dynamic
    // URL button gets its own component, indexed by its 0-based slot in the
    // template's BUTTONS component.
    const fetchSpy = mockSendOk();
    const result = await makeRpc().sendTemplateTest(
      input({ bodyParams: ["Ada"], buttonParams: [{ index: 0, text: "https://e.cc/track/T-4" }] }),
      TEST_ACCOUNT_ID,
    );
    expect(result).toEqual({ ok: true, messageId: "wamid.SENT" });
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(body.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Ada" }] },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "https://e.cc/track/T-4" }],
      },
    ]);
  });

  it("carries button components even when the body has no parameters", async () => {
    // The body component only exists when there are body params; a button
    // fill must still arrive on its own.
    const fetchSpy = mockSendOk();
    await makeRpc().sendTemplateTest(
      input({ buttonParams: [{ index: 1, text: "https://e.cc/status?t=T-4" }] }),
      TEST_ACCOUNT_ID,
    );
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(body.template.components).toEqual([
      {
        type: "button",
        sub_type: "url",
        index: "1",
        parameters: [{ type: "text", text: "https://e.cc/status?t=T-4" }],
      },
    ]);
  });

  it("fails closed for a WABA the account does not own, without calling Meta", async () => {
    // Tenant isolation: ownership is decided by the control plane before any
    // credential is opened.
    const fetchSpy = mockSendOk();
    const error = await makeRpc()
      .sendTemplateTest(input(), "other-account")
      .then(() => null, (reason) => reason);
    expect(String(error?.message ?? error)).toMatch(/not owned|does not exist/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed for a pending or failed WABA, without calling Meta", async () => {
    // The same invariant `routes.spec.ts` pins for POST /v1/.../messages: an
    // unprovisioned tenant cannot send, whichever door the send arrives at.
    await runInDurableObject(getControlPlaneStub(env), async (cp) => {
      await cp.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_SEND_PENDING",
        metaAccessToken: "pending-token",
        provisioningStatus: "pending",
        phones: [{ phoneNumberId: "PNID_SEND_PENDING" }],
      });
      await cp.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_SEND_FAILED",
        metaAccessToken: "failed-token",
        provisioningStatus: "failed",
        phones: [{ phoneNumberId: "PNID_SEND_FAILED" }],
      });
    });
    const fetchSpy = mockSendOk();
    for (const [wabaId, phoneNumberId] of [
      ["WABA_SEND_PENDING", "PNID_SEND_PENDING"],
      ["WABA_SEND_FAILED", "PNID_SEND_FAILED"],
    ]) {
      const error = await makeRpc()
        .sendTemplateTest(input({ wabaId, phoneNumberId }), TEST_ACCOUNT_ID)
        .then(() => null, (reason) => reason);
      expect(String(error?.message ?? error), wabaId).toMatch(/not owned/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns no_phone for a phone that is not registered on the WABA", async () => {
    // A result rather than a throw: the account's phones genuinely change
    // between the page load that offered this phone and the click that used it.
    const fetchSpy = mockSendOk();
    const result = await makeRpc().sendTemplateTest(
      input({ phoneNumberId: "PNID_UNKNOWN" }),
      TEST_ACCOUNT_ID,
    );
    expect(result).toMatchObject({ ok: false, code: "no_phone" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses on the SHARED rate-limit key before Meta is called", async () => {
    // THIS ASSERTION EXISTS TO FAIL if anyone ever forks the RPC send off the
    // per-tenant budget. The key must be byte-identical to the HTTP
    // middleware's (`routes.spec.ts`: `${TEST_ACCOUNT_ID}:WABA_TEST`) — a
    // compromised console session must not hold a bigger send budget than a
    // stolen API key.
    const limit = vi.fn(async () => ({ success: false }));
    (env as { SEND_RATE_LIMITER?: RateLimit }).SEND_RATE_LIMITER = { limit };
    const fetchSpy = mockSendOk();

    const result = await makeRpc().sendTemplateTest(input(), TEST_ACCOUNT_ID);
    expect(result).toEqual({ ok: false, code: "rate_limited", detail: null });
    expect(limit).toHaveBeenCalledWith({ key: `${TEST_ACCOUNT_ID}:${TEST_WABA_ID}` });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps Meta's error codes to the closed vocabulary and logs a failed row", async () => {
    // Legible failures: the console renders per-code copy, so raw Graph JSON
    // never becomes the UI's contract. An unknown code degrades to `graph`
    // carrying Meta's own sentence.
    const cases = [
      { code: 131030, expected: "recipient_not_allowlisted" },
      { code: 132001, expected: "template_not_found" },
      { code: 132000, expected: "parameter_mismatch" },
      { code: 999999, expected: "graph" },
    ] as const;

    for (const { code, expected } of cases) {
      vi.restoreAllMocks();
      mockSendError(code, `meta says ${code}`);
      const result = await makeRpc().sendTemplateTest(input(), TEST_ACCOUNT_ID);
      expect(result, String(code)).toEqual({
        ok: false,
        code: expected,
        detail: `meta says ${code}`,
      });
    }

    const rows = await makeRpc().listOutbound({ wabaId: TEST_WABA_ID }, TEST_ACCOUNT_ID);
    expect(rows).toHaveLength(cases.length);
    expect(rows.every((row) => row.status === "failed")).toBe(true);
  });

  it("falls back to the HTTP status when Meta sends no message text", async () => {
    mockSendError(null, "", 502);
    const result = await makeRpc().sendTemplateTest(input(), TEST_ACCOUNT_ID);
    expect(result).toEqual({ ok: false, code: "graph", detail: "HTTP 502" });
  });

  it("throws on malformed input, because only a regressed console can produce it", async () => {
    const fetchSpy = mockSendOk();
    for (const bad of [
      { to: "not-a-number" },
      { templateName: "Hello World" },
      { languageCode: "english" },
      { bodyParams: ["line one\nline two"] },
      { bodyParams: Array.from({ length: 31 }, () => "x") },
      { buttonParams: [{ index: 0.5, text: "x" }] },
      { buttonParams: [{ index: -1, text: "x" }] },
      { buttonParams: [{ index: 12, text: "x" }] },
      { buttonParams: [{ index: 0, text: "" }] },
      { buttonParams: [{ index: "0", text: "x" }] },
      { buttonParams: [{ index: 0, text: "a\nb" }] },
      { buttonParams: Array.from({ length: 4 }, () => ({ index: 0, text: "x" })) },
    ]) {
      const error = await makeRpc()
        .sendTemplateTest(input(bad), TEST_ACCOUNT_ID)
        .then(() => null, (reason) => reason);
      expect(error, JSON.stringify(bad)).not.toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
