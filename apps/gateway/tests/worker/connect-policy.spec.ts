import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { EccosControlPlane } from "../../src/control-plane";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import {
  bootstrapAccount,
  gatewayStub,
  holdAlarms,
  metaEnvelope,
  runAlarm,
  SUBSCRIBER_URL,
  TEST_ACCOUNT_ID,
  TEST_WABA_ID,
} from "./helpers";

const NEW_WABA = "WABA_NEW";
const TOKEN = "EAAtestwabatoken0000000000policy";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function rpc(): GatewayRPC {
  return new GatewayRPC(createExecutionContext(), env);
}

/** Meta with one own-app token that reaches NEW_WABA and its one phone. */
function mockGraph() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "business-token" }), { status: 200 });
    }
    if (url.includes("/debug_token")) {
      return new Response(
        JSON.stringify({
          data: {
            app_id: "test-app-id",
            is_valid: true,
            granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [NEW_WABA] }],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes(`/${NEW_WABA}/phone_numbers`)) {
      return new Response(JSON.stringify({ data: [{ id: "PN_NEW", display_phone_number: "+34600000001" }] }), {
        status: 200,
      });
    }
    if (url.includes("/messages")) {
      return new Response(JSON.stringify({ messages: [{ id: "wamid.SENT" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
}

async function expectNothingNew() {
  await cp((i) => {
    expect(i.sql.exec("SELECT waba_id FROM wabas").toArray()).toEqual([{ waba_id: TEST_WABA_ID }]);
    expect(i.sql.exec("SELECT phone_number_id FROM phones").toArray()).toEqual([{ phone_number_id: "PNID1" }]);
  });
}

function pendingInput(wabaId: string, phones: string[], token = "tenant-token") {
  return {
    accountId: TEST_ACCOUNT_ID,
    wabaId,
    metaAccessToken: token,
    callbackUrl: "https://gateway.example/webhooks/meta",
    phones: phones.map((phoneNumberId) => ({ phoneNumberId })),
  };
}

let apiKey = "";

beforeEach(async () => {
  apiKey = (await bootstrapAccount()).apiKey;
  await holdAlarms();
});

afterEach(async () => {
  delete (env as { CONNECT_POLICY_DEFAULT?: string }).CONNECT_POLICY_DEFAULT;
  vi.restoreAllMocks();
  await reset();
});

describe("connect policy off (self-host)", () => {
  it("is open with no var and no stored policy, and many numbers connect", async () => {
    await cp(async (i) => {
      await i.beginWabaProvisioningBatch([
        pendingInput("WABA_A", ["PN_A1", "PN_A2", "PN_A3"]),
        pendingInput("WABA_B", ["PN_B1", "PN_B2"]),
      ]);
      await i.registerWaba({ ...pendingInput("WABA_C", ["PN_C1"]), provisioningStatus: "active" });
      const resources = i.listAccountResources(TEST_ACCOUNT_ID);
      expect(resources.account?.connectPolicy).toBe("open");
      expect(resources.phones).toHaveLength(7);
      expect(i.getAccountBilling(TEST_ACCOUNT_ID)).toEqual({
        connectPolicy: "open",
        customerId: null,
        subscriptionId: null,
      });
      expect(i.listBilledAccounts()).toEqual([]);
    });
  });
});

describe("connect policy closed", () => {
  beforeEach(async () => {
    await cp((i) => i.setAccountBilling(TEST_ACCOUNT_ID, { connectPolicy: "closed" }));
  });

  it("the Embedded Signup callback refuses a new number", async () => {
    mockGraph();
    const { url, state } = await rpc().startConnectForAccountId(TEST_ACCOUNT_ID, "https://app.eccos.chat/numbers");
    const handoff = await exports.default.fetch(url, { redirect: "manual" });
    const res = await exports.default.fetch(
      `https://gateway.example/connect?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: handoff.headers.getSetCookie().join("; ") }, redirect: "manual" },
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("connectError")).toBe(
      "subscription_required",
    );
    await expectNothingNew();
  });

  it("/connect/exchange refuses a new number", async () => {
    mockGraph();
    await cp((i) => i.startConnectState("state-closed", TEST_ACCOUNT_ID, Date.now() + 60_000));
    const res = await exports.default.fetch("https://example.com/connect/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ code: "oauth-code", state: "state-closed" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "subscription_required" });
    await expectNothingNew();
  });

  it("a pasted token refuses a new number", async () => {
    mockGraph();
    expect(await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, TOKEN)).toMatchObject({
      ok: false,
      code: "subscription_required",
    });
    await expectNothingNew();
  });

  it("the admin route answers 402 for a new number", async () => {
    const res = await exports.default.fetch(`https://example.com/v1/accounts/${TEST_ACCOUNT_ID}/wabas`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.ECCOS_ADMIN_API_KEY}` },
      body: JSON.stringify({ wabaId: NEW_WABA, meta_access_token: "token", phones: [{ phoneNumberId: "PN_NEW" }] }),
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, code: "subscription_required" });
    await expectNothingNew();
  });

  it("a new phone on an existing WABA is left out, and the phone it had is re-registered", async () => {
    await cp(async (i) => {
      const result = await i.registerWaba({
        ...pendingInput(TEST_WABA_ID, ["PNID1", "PNID2"], "fresh-token"),
        provisioningStatus: "active",
      });
      expect(result.phones.map((phone) => phone.phoneNumberId)).toEqual(["PNID1"]);
      expect(result.refusedPhones?.map((phone) => phone.phoneNumberId)).toEqual(["PNID2"]);
      expect(result.waba.metaAccessToken).toBe("fresh-token");
    });
    await expectNothingNew();
  });

  it("a reconnect that swaps the number for a new one keeps the old one and adds nothing", async () => {
    await cp(async (i) => {
      const result = await i.beginWabaProvisioning(pendingInput(TEST_WABA_ID, ["PN_SWAP"]));
      expect(result.refusedPhones?.map((phone) => phone.phoneNumberId)).toEqual(["PN_SWAP"]);
    });
    await expectNothingNew();
  });

  it("a new WABA with no phone is refused too", async () => {
    await cp(async (i) => {
      await expect(i.beginWabaProvisioning(pendingInput(NEW_WABA, []))).rejects.toThrow("subscription required");
    });
    await expectNothingNew();
  });

  it("a token that sees the existing WABA and a new one refreshes the first and leaves out the second", async () => {
    const graph = mockGraph();
    graph.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "refreshed-token" }), { status: 200 });
      }
      if (url.includes("/debug_token")) {
        return new Response(
          JSON.stringify({
            data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [TEST_WABA_ID, NEW_WABA] }] },
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/${TEST_WABA_ID}/phone_numbers`)) {
        return new Response(JSON.stringify({ data: [{ id: "PNID1", display_phone_number: "+34600000000" }] }), { status: 200 });
      }
      if (url.includes(`/${NEW_WABA}/phone_numbers`)) {
        return new Response(JSON.stringify({ data: [{ id: "PN_NEW", display_phone_number: "+34600000001" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const { url, state } = await rpc().startConnectForAccountId(TEST_ACCOUNT_ID, "https://app.eccos.chat/numbers");
    const handoff = await exports.default.fetch(url, { redirect: "manual" });
    const res = await exports.default.fetch(
      `https://gateway.example/connect?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: handoff.headers.getSetCookie().join("; ") }, redirect: "manual" },
    );
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("connectError")).toBe("subscription_required");
    await expectNothingNew();
    await cp(async (i) => {
      expect((await i.getWabaRecord(TEST_ACCOUNT_ID, TEST_WABA_ID))?.metaAccessToken).toBe("refreshed-token");
    });
  });

  it("re-registering an existing number succeeds", async () => {
    await cp(async (i) => {
      const again = await i.beginWabaProvisioning(pendingInput(TEST_WABA_ID, ["PNID1"], "fresh-token"));
      expect(again.phones.map((phone) => phone.phoneNumberId)).toEqual(["PNID1"]);
      expect((await i.getWabaRecord(TEST_ACCOUNT_ID, TEST_WABA_ID))?.metaAccessToken).toBe("fresh-token");
    });
  });

  it("adoption adds nothing", async () => {
    await cp(async (i) => {
      // Connected without a phone while the account could still add numbers.
      i.setAccountBilling(TEST_ACCOUNT_ID, { connectPolicy: "open" });
      await i.beginWabaProvisioning(pendingInput(NEW_WABA, []));
      i.setAccountBilling(TEST_ACCOUNT_ID, { connectPolicy: "closed" });
      const claim = await i.claimWabaProvisioning(TEST_ACCOUNT_ID, NEW_WABA);
      if (!claim) throw new Error("expected a provisioning claim");
      const adopted = await i.adoptWabaPhones({
        accountId: TEST_ACCOUNT_ID,
        wabaId: NEW_WABA,
        revision: claim.revision,
        attempt: claim.attempt,
        phones: [{ phoneNumberId: "PN_NEW", displayPhoneNumber: "" }],
      });
      expect(adopted).toEqual([]);
      expect(i.sql.exec("SELECT phone_number_id FROM phones").toArray()).toEqual([{ phone_number_id: "PNID1" }]);
    });
  });

  it("still sends, receives and forwards", async () => {
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.saveConfig({ SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL });
    });
    const graph = mockGraph();

    const sent = await exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "34600000000", type: "text", text: { body: "hi" } }),
    });
    expect(sent.status).toBe(200);

    const body = JSON.stringify(
      metaEnvelope({
        messages: [{ from: "34600000000", id: "wamid.IN", timestamp: "1700000000", type: "text", text: { body: "hello" } }],
      }),
    );
    const inbound = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
      body,
    });
    expect(inbound.status).toBe(200);

    await runAlarm();
    const forwarded = graph.mock.calls.find(
      ([input, init]) => String(input) === SUBSCRIBER_URL && String(init?.body ?? "").includes("wamid.IN"),
    );
    expect(forwarded).toBeDefined();
  });
});

describe("connect policy default and billing state", () => {
  it("CONNECT_POLICY_DEFAULT=closed closes accounts without a stored policy, and a stored one wins", async () => {
    (env as { CONNECT_POLICY_DEFAULT?: string }).CONNECT_POLICY_DEFAULT = "closed";
    await cp(async (i) => {
      expect(i.listAccountResources(TEST_ACCOUNT_ID).account?.connectPolicy).toBe("closed");
      await expect(i.beginWabaProvisioning(pendingInput(NEW_WABA, ["PN_NEW"]))).rejects.toThrow(
        "subscription required",
      );
      i.setAccountBilling(TEST_ACCOUNT_ID, { connectPolicy: "open" });
      const opened = await i.beginWabaProvisioning(pendingInput(NEW_WABA, ["PN_NEW"]));
      expect(opened.phones).toHaveLength(1);
    });
  });

  it("stores the billing ids, keeps them when omitted, and lists billed accounts with their active numbers", async () => {
    const gateway = rpc();
    await gateway.setAccountBilling(TEST_ACCOUNT_ID, {
      connectPolicy: "open",
      customerId: "cust_1",
      subscriptionId: "sub_1",
    });
    await cp((i) => i.beginWabaProvisioning(pendingInput(NEW_WABA, ["PN_NEW"])));
    expect(await gateway.setAccountBilling(TEST_ACCOUNT_ID, { connectPolicy: "closed" })).toEqual({
      connectPolicy: "closed",
      customerId: "cust_1",
      subscriptionId: "sub_1",
    });
    expect(await gateway.listBilledAccounts()).toEqual([
      { accountId: TEST_ACCOUNT_ID, subscriptionId: "sub_1", billableNumbers: 1 },
    ]);
  });

  it("writes only while the stored subscription is the expected one, never stores an empty id, and forgets an ended one", async () => {
    const gateway = rpc();
    const first = { connectPolicy: "open" as const, customerId: "cust_1", subscriptionId: "sub_1" };
    await gateway.setAccountBilling(TEST_ACCOUNT_ID, first);
    // A stale writer that read another subscription changes nothing.
    expect(
      await gateway.setAccountBilling(TEST_ACCOUNT_ID, { connectPolicy: "closed", ifSubscriptionId: "sub_0" }),
    ).toEqual(first);
    expect(
      await gateway.setAccountBilling(TEST_ACCOUNT_ID, { connectPolicy: "open", customerId: "", ifSubscriptionId: "sub_1" }),
    ).toEqual(first);
    expect(
      await gateway.setAccountBilling(TEST_ACCOUNT_ID, { connectPolicy: "closed", subscriptionId: null }),
    ).toEqual({ connectPolicy: "closed", customerId: "cust_1", subscriptionId: null });
    expect(await gateway.listBilledAccounts()).toEqual([]);
  });

  it("an account that does not exist has no billing", async () => {
    expect(await rpc().getAccountBilling("acc-nobody")).toBeNull();
  });
});
