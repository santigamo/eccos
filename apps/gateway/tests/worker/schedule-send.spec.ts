import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleSendInput } from "@eccos/gateway-contract";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { MAX_PENDING_SCHEDULED } from "../../src/scheduled";
import { bootstrapAccount, gatewayStub, holdAlarms, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const rpc = () => new GatewayRPC(createExecutionContext(), env);
let API_KEY = "";
let templateStatus = "APPROVED";
let graphCalls: string[] = [];

beforeEach(async () => {
  API_KEY = (await bootstrapAccount()).apiKey;
  await holdAlarms();
  templateStatus = "APPROVED";
  graphCalls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    graphCalls.push(url);
    if (url.includes("/message_templates")) {
      return Response.json({ data: [{ name: "reminder", language: "es", status: templateStatus }] });
    }
    return Response.json({ messages: [{ id: "wamid.1" }] });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function input(overrides: Partial<ScheduleSendInput> = {}): ScheduleSendInput {
  const sendAt = Date.now() + DAY;
  return {
    wabaId: TEST_WABA_ID,
    phoneNumberId: "PNID1",
    to: "34600111222",
    templateName: "reminder",
    languageCode: "es",
    bodyValues: { nombre: "Ana", hora: "13:30" },
    key: "console-20261128-0900-x7k2",
    sendAt,
    expiresAt: sendAt + HOUR,
    ...overrides,
  };
}

function storedComponents(key: string): Promise<unknown> {
  return runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
    const row = instance.sql.exec("SELECT components FROM scheduled_sends WHERE key = ?", key).toArray()[0];
    return row?.components == null ? null : JSON.parse(String(row.components));
  });
}

describe("GatewayRPC.scheduleSend", () => {
  it("creates a pending send with named body values and sends nothing now", async () => {
    const result = await rpc().scheduleSend(input(), TEST_ACCOUNT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheduled).toMatchObject({ key: "console-20261128-0900-x7k2", status: "pending", to: "34600111222" });
    expect(await storedComponents("console-20261128-0900-x7k2")).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", parameter_name: "nombre", text: "Ana" },
          { type: "text", parameter_name: "hora", text: "13:30" },
        ],
      },
    ]);
    expect(graphCalls.some((url) => url.endsWith("/messages"))).toBe(false);
  });

  it("stores positional values and a bare template without components", async () => {
    await rpc().scheduleSend(input({ key: "pos", bodyValues: undefined, bodyParams: ["Ana"] }), TEST_ACCOUNT_ID);
    expect(await storedComponents("pos")).toEqual([{ type: "body", parameters: [{ type: "text", text: "Ana" }] }]);
    await rpc().scheduleSend(input({ key: "bare", bodyValues: undefined }), TEST_ACCOUNT_ID);
    expect(await storedComponents("bare")).toBeNull();
  });

  it("refuses a key an integration holds and leaves that send untouched", async () => {
    const sendAt = Date.now() + 2 * DAY;
    const res = await exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/scheduled/appt-8812`, {
      method: "PUT",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "34600000001", template: { name: "reminder", language: "es" }, sendAt }),
    });
    expect(res.status).toBe(201);

    const result = await rpc().scheduleSend(input({ key: "appt-8812" }), TEST_ACCOUNT_ID);
    expect(result).toMatchObject({ ok: false, code: "key_exists", existing: { key: "appt-8812", status: "pending", sendAt } });
    const row = await gatewayStub().getScheduled(TEST_ACCOUNT_ID, "appt-8812");
    expect(row).toMatchObject({ to: "34600000001", sendAt });
  });

  it("refuses a cancelled key too: the console never reuses one", async () => {
    await rpc().scheduleSend(input({ key: "gone" }), TEST_ACCOUNT_ID);
    await rpc().cancelScheduled({ wabaId: TEST_WABA_ID, key: "gone" }, TEST_ACCOUNT_ID);
    const result = await rpc().scheduleSend(input({ key: "gone" }), TEST_ACCOUNT_ID);
    expect(result).toMatchObject({ ok: false, code: "key_exists", existing: { status: "cancelled" } });
  });

  it("applies the PUT's time rules", async () => {
    const now = Date.now();
    const cases: Partial<ScheduleSendInput>[] = [
      { sendAt: now + 91 * DAY, expiresAt: now + 91 * DAY + HOUR },
      { sendAt: now + DAY, expiresAt: now + DAY },
      { sendAt: now + DAY, expiresAt: now + 9 * DAY },
    ];
    for (const times of cases) {
      const result = await rpc().scheduleSend(input(times), TEST_ACCOUNT_ID);
      expect(result).toMatchObject({ ok: false, code: "invalid_time" });
      if (!result.ok) expect(result.detail).toMatch(/sendAt|expiresAt/);
    }
  });

  it("calls a refusal that is not about the time invalid_request, with the gateway's reason", async () => {
    const bodyParams = Array.from({ length: 30 }, () => "x".repeat(1000));
    const result = await rpc().scheduleSend(input({ bodyValues: undefined, bodyParams }), TEST_ACCOUNT_ID);
    expect(result).toEqual({ ok: false, code: "invalid_request", detail: "template.components are too large" });
  });

  it("creates once when two requests race for the same key", async () => {
    const results = await Promise.all([
      rpc().scheduleSend(input({ key: "race" }), TEST_ACCOUNT_ID),
      rpc().scheduleSend(input({ key: "race", to: "34600999888" }), TEST_ACCOUNT_ID),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "key_exists")).toHaveLength(1);
    const stored = await runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
      instance.sql.exec("SELECT COUNT(*) AS n FROM scheduled_sends WHERE key = 'race'").one().n,
    );
    expect(stored).toBe(1);
  });

  it("refuses a template Meta does not list as approved, or cannot be asked about", async () => {
    templateStatus = "PAUSED";
    expect(await rpc().scheduleSend(input(), TEST_ACCOUNT_ID)).toMatchObject({
      ok: false,
      code: "template_not_approved",
      templateStatus: "PAUSED",
    });
    expect(await rpc().scheduleSend(input({ templateName: "other" }), TEST_ACCOUNT_ID)).toMatchObject({
      ok: false,
      code: "template_not_found",
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ error: { message: "down" } }, { status: 500 }));
    expect(await rpc().scheduleSend(input(), TEST_ACCOUNT_ID)).toMatchObject({ ok: false, code: "templates_unreachable" });
    expect(await gatewayStub().getScheduled(TEST_ACCOUNT_ID, input().key)).toBeNull();
  });

  it("refuses while sending is paused, and for a phone the WABA no longer has", async () => {
    expect(await rpc().scheduleSend(input({ phoneNumberId: "PNID9" }), TEST_ACCOUNT_ID)).toMatchObject({
      ok: false,
      code: "no_phone",
    });
    await getControlPlaneStub(env).setAccountBilling(TEST_ACCOUNT_ID, { billingStatus: "paused" });
    expect(await rpc().scheduleSend(input(), TEST_ACCOUNT_ID)).toMatchObject({ ok: false, code: "subscription_required" });
  });

  it("refuses past the pending ceiling", async () => {
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO scheduled_sends (account_id, key, phone_number_id, recipient, template_name, language, status,
           send_at, expires_at, next_attempt_at, created_at, updated_at)
         SELECT ?, 'k' || i, 'PNID1', '34600000001', 'reminder', 'es', 'pending', 1, 2, 1, 1, 1 FROM n`,
        MAX_PENDING_SCHEDULED,
        TEST_ACCOUNT_ID,
      );
    });
    expect(await rpc().scheduleSend(input(), TEST_ACCOUNT_ID)).toMatchObject({ ok: false, code: "too_many_pending" });
  });

  it("throws on a malformed key or recipient, and for an account that does not own the WABA", async () => {
    await expect(rpc().scheduleSend(input({ key: "a/b" }), TEST_ACCOUNT_ID)).rejects.toThrow(/invalid key/);
    await expect(rpc().scheduleSend(input({ to: "+34 600" }), TEST_ACCOUNT_ID)).rejects.toThrow(/to must be/);
    await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID2" }]);
    await expect(rpc().scheduleSend(input(), "other-account")).rejects.toThrow(/is not owned by account/);
  });
});
