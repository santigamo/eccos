/**
 * Every outbound send logs its WABA, phone and, on failure, Meta's error codes,
 * never the recipient, the content or Meta's free-text message.
 */
import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, holdAlarms, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

const TO = "34611112222";
const SECRET = "secret text";
let apiKey = "";
let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  apiKey = (await bootstrapAccount()).apiKey;
  await holdAlarms();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function sendLines(): Record<string, unknown>[] {
  return log.mock.calls
    .map(([arg]) => (typeof arg === "string" && arg.startsWith("{") ? JSON.parse(arg) : null))
    .filter((line) => line?.event === "outbound_send");
}

function mockGraph(status: number, body: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

const WINDOW_CLOSED = {
  error: {
    code: 131047,
    error_subcode: 2494010,
    type: "OAuthException",
    message: `Re-engagement message to ${TO}`,
    error_data: { details: `${SECRET} for ${TO}` },
  },
};

function send(path = `/v1/wabas/${TEST_WABA_ID}/messages`) {
  return exports.default.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ to: TO, type: "text", text: { body: SECRET } }),
  });
}

function expectNoLeak() {
  expect(JSON.stringify(log.mock.calls)).not.toMatch(new RegExp(`${SECRET}|${TO}|Re-engagement`));
}

describe("outbound_send log lines", () => {
  it("names the WABA and phone of a successful send", async () => {
    mockGraph(200, { contacts: [{ wa_id: TO }], messages: [{ id: "wamid.OK" }] });
    expect((await send()).status).toBe(200);
    expect(sendLines()).toEqual([
      expect.objectContaining({
        status: 200,
        wabaId: TEST_WABA_ID,
        phoneNumberId: "PNID1",
        messageType: "text",
        messageId: "wamid.OK",
        ok: true,
      }),
    ]);
    expectNoLeak();
  });

  it("carries Meta's error codes, not its message, on a failed send", async () => {
    mockGraph(400, WINDOW_CLOSED);
    expect((await send()).status).toBe(502);
    expect(sendLines()).toEqual([
      expect.objectContaining({
        level: "error",
        status: 502,
        wabaId: TEST_WABA_ID,
        phoneNumberId: "PNID1",
        messageType: "text",
        ok: false,
        httpStatus: 400,
        errorCode: 131047,
        errorSubcode: 2494010,
        errorType: "OAuthException",
      }),
    ]);
    expectNoLeak();
  });

  it("marks a network failure with httpStatus 0 and no Meta codes", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`connect failed for ${TO}`));
    expect((await send()).status).toBe(502);
    expect(sendLines()).toEqual([
      expect.objectContaining({ wabaId: TEST_WABA_ID, ok: false, httpStatus: 0, errorCode: null }),
    ]);
    expectNoLeak();
  });

  it("names the requested WABA of an invalid target, not the path's phone", async () => {
    expect((await send(`/v1/wabas/${TEST_WABA_ID}/phones/PN_OTHER/messages`)).status).toBe(404);
    const [line] = sendLines();
    expect(line).toEqual(expect.objectContaining({ reason: "invalid_target", wabaId: TEST_WABA_ID }));
    expect(line).not.toHaveProperty("phoneNumberId");
    expectNoLeak();
  });

  it("logs a console send the same way", async () => {
    mockGraph(400, WINDOW_CLOSED);
    const rpc = new GatewayRPC(createExecutionContext(), env);
    await rpc.sendText({ wabaId: TEST_WABA_ID, phoneNumberId: "PNID1", to: TO, text: SECRET }, TEST_ACCOUNT_ID);
    expect(sendLines()).toEqual([
      expect.objectContaining({
        area: "rpc",
        source: "send_text",
        wabaId: TEST_WABA_ID,
        phoneNumberId: "PNID1",
        messageType: "text",
        ok: false,
        httpStatus: 400,
        errorCode: 131047,
        errorSubcode: 2494010,
        errorType: "OAuthException",
      }),
    ]);
    expectNoLeak();
  });
});
