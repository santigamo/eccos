import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateBroadcastInput } from "@eccos/gateway-contract";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, gatewayStub, holdAlarms, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

const ORG_ID = "org_broadcast_create";
const rpc = () => new GatewayRPC(createExecutionContext(), env);
let API_KEY = "";

const TEMPLATE = {
  name: "order_ready",
  language: "es",
  id: "1",
  category: "UTILITY",
  parameter_format: "POSITIONAL",
  components: [{ type: "BODY", text: "Hola {{1}}, recógelo el {{2}}." }],
};

let templateStatus: string | null = "APPROVED";
let templateComponents: unknown[] = TEMPLATE.components;

beforeEach(async () => {
  templateStatus = "APPROVED";
  templateComponents = TEMPLATE.components;
  API_KEY = (await bootstrapAccount()).apiKey;
  await holdAlarms();
  await runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
    cp.sql.exec(
      "INSERT INTO organization_accounts (organization_id, account_id, status, created_at) VALUES (?, ?, 'active', ?)",
      ORG_ID,
      TEST_ACCOUNT_ID,
      Date.now(),
    );
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/message_templates")) {
      const data = templateStatus === null ? [] : [{ ...TEMPLATE, status: templateStatus, components: templateComponents }];
      return Response.json({ data });
    }
    return Response.json({ messages: [{ id: "wamid.1" }] });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const input = (patch: Partial<CreateBroadcastInput> = {}): CreateBroadcastInput => ({
  wabaId: TEST_WABA_ID,
  phoneNumberId: "PNID1",
  templateName: "order_ready",
  languageCode: "es",
  label: "Friday pickups",
  columns: [
    { kind: "body", key: "1" },
    { kind: "body", key: "2" },
  ],
  recipients: [
    { to: "34600111222", values: ["Ana", "viernes"] },
    { to: "34600333444", values: ["Luis", "sábado"] },
  ],
  idempotencyKey: "review-1",
  ...patch,
});

async function storedComponents(): Promise<unknown[]> {
  return runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
    instance.sql
      .exec(`SELECT components FROM broadcast_recipients ORDER BY seq`)
      .toArray()
      .map((row) => JSON.parse(String(row.components))),
  );
}

describe("createBroadcast", () => {
  it("queues the rows with the label and the components built against the template", async () => {
    const result = await rpc().createBroadcast(input(), TEST_ACCOUNT_ID);
    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      broadcast: { status: "running", total: 2, label: "Friday pickups", template: { name: "order_ready", language: "es" } },
    });
    expect((await storedComponents())[1]).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Luis" }, { type: "text", text: "sábado" }] },
    ]);
  });

  it("replays the same review, and refuses its key for another one", async () => {
    const first = await rpc().createBroadcast(input(), TEST_ACCOUNT_ID);
    const again = await rpc().createBroadcast(input(), TEST_ACCOUNT_ID);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(first.ok && again.ok && again.broadcast.id).toBe(first.ok && first.broadcast.id);
    expect(await rpc().createBroadcast(input({ label: "Another" }), TEST_ACCOUNT_ID)).toEqual({
      ok: false,
      code: "key_reused",
      detail: null,
    });
  });

  it("answers a closed code for each refusal, and queues nothing", async () => {
    expect(await rpc().createBroadcast(input({ phoneNumberId: "PNID9" }), TEST_ACCOUNT_ID)).toMatchObject({ code: "no_phone" });
    expect(await rpc().createBroadcast(input({ columns: [{ kind: "body", key: "1" }] }), TEST_ACCOUNT_ID)).toMatchObject({
      code: "parameter_mismatch",
    });
    expect(
      await rpc().createBroadcast(input({ recipients: [{ to: "34600111222", values: ["Ana", ""] }, { to: "x", values: ["A", "B"] }] }), TEST_ACCOUNT_ID),
    ).toMatchObject({ code: "invalid_recipients", invalid: [{ index: 0 }] });
    expect(await rpc().createBroadcast(input({ recipients: [{ to: "x", values: ["A", "B"] }] }), TEST_ACCOUNT_ID)).toMatchObject({
      code: "invalid_recipients",
      invalid: [{ index: 0, error: "to must be a phone number (5-15 digits) or a BSUID" }],
    });
    templateStatus = "PAUSED";
    expect(await rpc().createBroadcast(input(), TEST_ACCOUNT_ID)).toEqual({
      ok: false,
      code: "template_not_approved",
      detail: null,
      templateStatus: "PAUSED",
    });
    templateStatus = null;
    expect(await rpc().createBroadcast(input(), TEST_ACCOUNT_ID)).toMatchObject({ code: "template_not_found" });
    templateStatus = "APPROVED";
    templateComponents = [{ type: "BODY", text: "Code {{1}}" }, { type: "BUTTONS", buttons: [{ type: "OTP" }] }];
    expect(await rpc().createBroadcast(input(), TEST_ACCOUNT_ID)).toMatchObject({ code: "template_unsupported" });
    await getControlPlaneStub(env).setAccountBilling(TEST_ACCOUNT_ID, { billingStatus: "paused" });
    expect(await rpc().createBroadcast(input(), TEST_ACCOUNT_ID)).toMatchObject({ code: "subscription_required" });
    expect((await rpc().readBroadcasts({ organizationId: ORG_ID }, {})).data.items).toEqual([]);
  });

  it("is too_many_running past five, and the preflight says so", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await rpc().createBroadcast(input({ idempotencyKey: `k${i}` }), TEST_ACCOUNT_ID)).toMatchObject({ ok: true });
    }
    expect(await rpc().createBroadcast(input({ idempotencyKey: "k6" }), TEST_ACCOUNT_ID)).toMatchObject({ code: "too_many_running" });
    const preflight = await rpc().readBroadcastPreflight({ organizationId: ORG_ID });
    expect(preflight.data).toEqual({ running: 5, maxRunning: 5, pacePerMinute: 48, maxRecipients: 10_000 });
  });

  it("throws for a WABA the account does not own", async () => {
    await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID2" }]);
    await expect(rpc().createBroadcast(input({ wabaId: "WABA_OTHER" }), TEST_ACCOUNT_ID)).rejects.toThrow(/is not owned by account/);
  });

  it("takes 10,000 rows of 5 values through the binding", async () => {
    templateComponents = [{ type: "BODY", text: "{{1}} {{2}} {{3}} {{4}} {{5}}" }];
    const recipients = Array.from({ length: 10_000 }, (_, i) => ({
      to: `346${String(i).padStart(8, "0")}`,
      values: [`Name ${i}`, "viernes", `ORD-${100_000 + i}`, "Calle Mayor 12", "10:30"],
    }));
    const big = input({ columns: ["1", "2", "3", "4", "5"].map((key) => ({ kind: "body" as const, key })), recipients });
    const bytes = JSON.stringify(big).length;
    const started = performance.now();
    const result = await rpc().createBroadcast(big, TEST_ACCOUNT_ID);
    const ms = performance.now() - started;
    // Measured locally: ~0.92 MB and ~135 ms. The bound only catches a pathological regression.
    expect(bytes).toBeLessThan(1_000_000);
    expect(ms).toBeLessThan(10_000);
    expect(result).toMatchObject({ ok: true, broadcast: { total: 10_000, counts: { queued: 10_000 } } });
  });
});

describe("POST /broadcasts label", () => {
  it("is optional, returned on the summary, and refused when too long", async () => {
    const post = (label: unknown) =>
      exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/broadcasts`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ template: { name: "order_ready", language: "es" }, recipients: [{ to: "34600111222" }], label }),
      });
    const created = await post("Black Friday");
    expect(created.status).toBe(202);
    expect(await created.json()).toMatchObject({ broadcast: { label: "Black Friday" } });
    expect((await post("x".repeat(81))).status).toBe(400);
    const plain = await post(undefined);
    expect(await plain.json()).toMatchObject({ broadcast: { label: null } });
  });
});
