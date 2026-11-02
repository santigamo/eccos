import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRPC } from "../../src/rpc";
import { SEND_KEY_TTL_MS, type EccosGateway } from "../../src/gateway";
import { bootstrapAccount, gatewayStub, holdAlarms, runAlarm, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

let API_KEY = "ek-test";
let wamid = 0;

beforeEach(async () => {
  API_KEY = (await bootstrapAccount()).apiKey;
  await holdAlarms();
  wamid = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const rpc = () => new GatewayRPC(createExecutionContext(), env);

function sendText(idempotencyKey?: string) {
  return rpc().sendText(
    { wabaId: TEST_WABA_ID, phoneNumberId: "PNID1", to: "34600000011", text: "Hola", idempotencyKey },
    TEST_ACCOUNT_ID,
  );
}

/** Meta accepts every send with a fresh wamid; `gate` holds each answer back until it resolves. */
function mockMeta(gate: Promise<void> = Promise.resolve()) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const id = `wamid.${++wamid}`;
    await gate;
    return new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 });
  });
}

const outboundRows = () => rpc().listOutbound({ wabaId: TEST_WABA_ID }, TEST_ACCOUNT_ID);

describe("console send idempotency", () => {
  it("a sequential duplicate returns the stored result and does not call Meta", async () => {
    const fetchSpy = mockMeta();
    const log = vi.spyOn(console, "log");
    const first = await sendText("key-1");
    const second = await sendText("key-1");
    expect(first).toEqual({ ok: true, messageId: "wamid.1" });
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await outboundRows()).toHaveLength(1);
    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"deduped":true'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("34600000011");
    expect(lines[0]).not.toContain("Hola");
  });

  it("a concurrent duplicate does not send: it is told the first is in progress", async () => {
    let release: () => void = () => {};
    const fetchSpy = mockMeta(new Promise((resolve) => {
      release = resolve;
    }));
    const first = sendText("key-1");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(await sendText("key-1")).toEqual({ ok: false, code: "in_progress", detail: null });
    release();
    expect(await first).toEqual({ ok: true, messageId: "wamid.1" });
    expect(await sendText("key-1")).toEqual({ ok: true, messageId: "wamid.1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("different keys, and no key, each send", async () => {
    const fetchSpy = mockMeta();
    expect(await sendText("key-1")).toEqual({ ok: true, messageId: "wamid.1" });
    expect(await sendText("key-2")).toEqual({ ok: true, messageId: "wamid.2" });
    expect(await sendText()).toEqual({ ok: true, messageId: "wamid.3" });
    expect(await sendText()).toEqual({ ok: true, messageId: "wamid.4" });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("a Meta refusal is stored too: a retry with the same key does not resend", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: { code: 131047, message: "window" } }), { status: 400 }));
    const first = await sendText("key-1");
    expect(first).toMatchObject({ ok: false, code: "window_closed" });
    expect(await sendText("key-1")).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("dedupes a template test send the same way", async () => {
    const fetchSpy = mockMeta();
    const send = () =>
      rpc().sendTemplateTest(
        {
          wabaId: TEST_WABA_ID,
          phoneNumberId: "PNID1",
          to: "34600000011",
          templateName: "hello_world",
          languageCode: "en_US",
          idempotencyKey: "key-t",
        },
        TEST_ACCOUNT_ID,
      );
    expect(await send()).toEqual({ ok: true, messageId: "wamid.1" });
    expect(await send()).toEqual({ ok: true, messageId: "wamid.1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed key before anything is sent", async () => {
    const fetchSpy = mockMeta();
    await expect(sendText("has space")).rejects.toThrow("invalid idempotencyKey");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a key expires after its TTL: a claim is new again and the sweep deletes it", async () => {
    mockMeta();
    await sendText("key-1");
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      const later = Date.now() + SEND_KEY_TTL_MS + 1;
      expect(instance.claimSendKey(TEST_ACCOUNT_ID, "key-1")).toMatchObject({ state: "done" });
      expect(instance.claimSendKey(TEST_ACCOUNT_ID, "key-1", later)).toEqual({ state: "new" });
    });

    await sendText("key-2");
    vi.useFakeTimers({ now: Date.now() + SEND_KEY_TTL_MS + 2 * 60 * 60 * 1000, toFake: ["Date"] });
    await runAlarm();
    vi.useRealTimers();
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      // key-1 was claimed afresh at `later` above; only key-2 is past its TTL.
      expect(instance.sql.exec("SELECT key FROM send_keys").toArray()).toEqual([{ key: "key-1" }]);
    });
  });
});

describe("POST /v1/wabas/:wabaId/messages with Idempotency-Key", () => {
  const post = (headers: Record<string, string> = {}) =>
    exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ to: "34600000011", type: "text", text: { body: "hi" } }),
    });

  it("returns the stored response for a repeated key and sends once", async () => {
    const fetchSpy = mockMeta();
    const first = await post({ "idempotency-key": "api-1" });
    const second = await post({ "idempotency-key": "api-1" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await post()).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("answers 409 while the first request with the key is in flight", async () => {
    let release: () => void = () => {};
    const fetchSpy = mockMeta(new Promise((resolve) => {
      release = resolve;
    }));
    const first = post({ "idempotency-key": "api-1" });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect((await post({ "idempotency-key": "api-1" })).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed key", async () => {
    const fetchSpy = mockMeta();
    expect((await post({ "idempotency-key": "a b" })).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
