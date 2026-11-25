import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

/**
 * Calls across the real GatewayRPC binding. Its arguments arrive as structured
 * clones, which keep an array's holes where JSON would write null, so a caller
 * on the binding can send what the console's JSON transport never could.
 */

const binding = (env as unknown as { GATEWAY_RPC: Service<GatewayRPC> }).GATEWAY_RPC;

beforeEach(async () => {
  await bootstrapAccount();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** Built in the caller, never parsed from JSON. */
function holed(length: number, filled: Record<number, unknown> = {}): unknown[] {
  const list = new Array(length);
  for (const [index, value] of Object.entries(filled)) list[Number(index)] = value;
  return list;
}

function mockMeta() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/messages")) {
      return Response.json({ messaging_product: "whatsapp", contacts: [{ wa_id: "34600000011" }], messages: [{ id: "wamid.X" }] });
    }
    if (url.includes("/message_templates")) {
      return Response.json({ data: [{ id: "555", name: "order_update", language: "en_US" }], id: "1234567890", status: "PENDING", category: "UTILITY" });
    }
    return Response.json({ success: true });
  });
}

/** The refusal message of one binding call, awaited once; "accepted" if it resolves. */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "accepted";
  } catch (error) {
    return (error as Error).message;
  }
}

function writes(fetchSpy: { mock: { calls: unknown[][] } }) {
  return fetchSpy.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") !== "GET");
}

const draft = {
  wabaId: TEST_WABA_ID,
  name: "order_update",
  language: "en_US",
  category: "UTILITY",
  bodyText: "Hi {{1}}, order {{2}}",
  bodyExamples: ["Ada", "42"],
};
const send = {
  wabaId: TEST_WABA_ID,
  phoneNumberId: "",
  to: "34600000011",
  templateName: "order_update",
  languageCode: "en_US",
  bodyParams: ["Ada", "42"],
};

describe("array holes across the GatewayRPC binding", () => {
  it("the binding is the real one: a valid create reaches Meta through it", async () => {
    const fetchSpy = mockMeta();
    await expect(binding.createTemplate(draft as never, TEST_ACCOUNT_ID)).resolves.toMatchObject({ ok: true });
    expect(writes(fetchSpy)).toHaveLength(1);
  });

  it("refuses holes in a create's or an edit's examples and buttons, and Meta hears nothing", async () => {
    const fetchSpy = mockMeta();
    const cases: [Record<string, unknown>, string][] = [
      [{ bodyExamples: holed(2) }, "example values must be strings"],
      [{ bodyExamples: holed(2, { 0: "Ada" }) }, "example values must be strings"],
      [{ buttons: holed(1) }, "buttons must be objects"],
      [{ buttons: holed(2, { 1: { text: "Open", url: "https://example.com" } }) }, "buttons must be objects"],
    ];
    for (const [overrides, message] of cases) {
      expect(await refusal(() => binding.createTemplate({ ...draft, ...overrides } as never, TEST_ACCOUNT_ID))).toBe(message);
      expect(
        await refusal(() => binding.editTemplate({ ...draft, templateId: "555", ...overrides } as never, TEST_ACCOUNT_ID)),
      ).toBe(message);
    }
    expect(writes(fetchSpy)).toHaveLength(0);
  });

  it("refuses holes in a test send's parameters, and Meta hears nothing", async () => {
    const fetchSpy = mockMeta();
    const phoneNumberId = (await env.CONTROL_PLANE.getByName("control-plane").getWaba(TEST_ACCOUNT_ID, TEST_WABA_ID))
      ?.phones[0]?.phoneNumberId;
    expect(phoneNumberId).toBeTruthy();
    const cases: [Record<string, unknown>, string][] = [
      [{ bodyParams: holed(2) }, "template parameters must be strings"],
      [{ bodyParams: holed(2, { 1: "42" }) }, "template parameters must be strings"],
      [{ buttonParams: holed(1) }, "button parameters must be objects"],
    ];
    for (const [overrides, message] of cases) {
      expect(
        await refusal(() => binding.sendTemplateTest({ ...send, phoneNumberId, ...overrides } as never, TEST_ACCOUNT_ID)),
      ).toBe(message);
    }
    expect(writes(fetchSpy)).toHaveLength(0);
  });
});
