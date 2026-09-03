import { env, exports } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { EccosGateway } from "../../src/gateway";
import type { EccosControlPlane } from "../../src/control-plane";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { getGatewayStubForWaba } from "../../src/gateway-stub";

function controlPlane(): EccosControlPlane {
  return getControlPlaneStub(env);
}

function admin(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.ECCOS_ADMIN_API_KEY}`,
      ...init.headers,
    },
  });
}

function adminJson(path: string, body: unknown): Promise<Response> {
  return admin(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function accountApi(apiKey: string, origin = "https://example.com") {
  return (path: string, init: RequestInit = {}): Promise<Response> =>
    exports.default.fetch(`${origin}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${apiKey}`, ...init.headers },
    });
}

async function createAccountHttp(accountId: string): Promise<{ accountId: string; apiKey: string; keyId: string }> {
  const response = await adminJson("/v1/accounts", { accountId });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { account: { accountId: string }; apiKey: string; keyId: string };
  return { accountId: body.account.accountId, apiKey: body.apiKey, keyId: body.keyId };
}

async function registerWabaHttp(
  accountId: string,
  wabaId: string,
  metaAccessToken: string,
  phones: Array<{ phoneNumberId: string; displayPhoneNumber?: string }>,
  subscriber?: { subscriber_webhook_url: string; subscriber_secret: string },
): Promise<Response> {
  const response = await adminJson(`/v1/accounts/${accountId}/wabas`, {
    wabaId,
    metaAccessToken,
    phones,
    ...subscriber,
  });
  if (response.status === 202) {
    const reconciled = await admin(`/v1/accounts/${accountId}/wabas/${wabaId}/reconcile`, { method: "POST" });
    expect(reconciled.status).toBe(200);
  }
  return response;
}

type GraphWaba = { wabaId: string; phones: Array<{ id: string; display_phone_number: string }> };

function mockGraph(wabas: GraphWaba[] = [{ wabaId: "WABA_OAUTH", phones: [{ id: "PN_OAUTH", display_phone_number: "+34 600 000 090" }] }]): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "business-token" }), { status: 200 });
    }
    if (url.includes("/debug_token")) {
      return new Response(
        JSON.stringify({
          data: {
            granular_scopes: [
              { scope: "whatsapp_business_management", target_ids: wabas.map((waba) => waba.wabaId) },
            ],
          },
        }),
        { status: 200 },
      );
    }
    const waba = wabas.find((candidate) => url.includes(`/${candidate.wabaId}/phone_numbers`));
    if (waba) {
      return new Response(JSON.stringify({ data: waba.phones }), { status: 200 });
    }
    if (url.includes("/messages")) {
      return new Response(JSON.stringify({ messages: [{ id: "wamid.MULTI" }] }), { status: 200 });
    }
    if (url.includes("/message_templates") || url.includes("/subscribed_apps")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  });
}

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(controlPlane(), fn);
}

async function createAccount(accountId: string): Promise<{ accountId: string; apiKey: string; keyId: string }> {
  return cp(async (i) => {
    const { account, apiKey, keyId } = await i.createAccount({ accountId });
    return { accountId: account.accountId, apiKey, keyId };
  });
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("account-scoped control plane", () => {
  it("stores only SHA-256 hashes of API keys — never the raw key", async () => {
    const { apiKey } = await createAccount("acc-hash");
    const hashHex = await sha256Hex(apiKey);

    await cp((i) => {
      const rows = i.sql.exec("SELECT hash FROM api_keys").toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.hash).toBe(hashHex);
      expect(rows[0]!.hash).not.toBe(apiKey);
      expect(apiKey.startsWith("ek_")).toBe(true);
    });
  });

  it("rejects unknown and revoked API keys while a valid key still authenticates", async () => {
    const { accountId, apiKey } = await createAccount("acc-keys");
    const revoked = await cp(async (i) => {
      const { apiKey: k, keyId: id } = await i.issueApiKey(accountId, "rotation");
      i.revokeApiKey(accountId, id);
      return k;
    });

    expect(await cp((i) => i.authenticateApiKey("ek_totally_unknown"))).toBeNull();
    expect(await cp((i) => i.authenticateApiKey("not-an-eccos-key"))).toBeNull();
    expect(await cp((i) => i.authenticateApiKey(revoked))).toBeNull();
    expect(await cp((i) => i.authenticateApiKey(apiKey))).toEqual({ accountId, keyId: expect.any(String) });
  });

  it("lets two accounts own multiple WABAs/phones and rejects duplicate ownership without mutation", async () => {
    const accA = await createAccount("acc-a");
    const accB = await createAccount("acc-b");

    await cp(async (i) => {
      await i.registerWaba({ accountId: accA.accountId, wabaId: "WABA_A1", metaAccessToken: "tok-a1", provisioningStatus: "active", phones: [{ phoneNumberId: "PN_A1_1", displayPhoneNumber: "+34 600 000 001" }] });
      await i.registerWaba({ accountId: accA.accountId, wabaId: "WABA_A2", metaAccessToken: "tok-a2", provisioningStatus: "active", phones: [{ phoneNumberId: "PN_A2_1", displayPhoneNumber: "+34 600 000 002" }] });
      await i.registerWaba({ accountId: accB.accountId, wabaId: "WABA_B1", metaAccessToken: "tok-b1", provisioningStatus: "active", phones: [{ phoneNumberId: "PN_B1_1", displayPhoneNumber: "+34 600 000 003" }] });
      await i.registerWaba({ accountId: accB.accountId, wabaId: "WABA_B2", metaAccessToken: "tok-b2", provisioningStatus: "active", phones: [{ phoneNumberId: "PN_B2_1", displayPhoneNumber: "+34 600 000 004" }] });
    });

    await expect(
      cp((i) => i.registerWaba({ accountId: accB.accountId, wabaId: "WABA_A1", metaAccessToken: "tok-x", provisioningStatus: "active", phones: [{ phoneNumberId: "PN_X" }] })),
    ).rejects.toThrow(/already registered to another account/);

    await expect(
      cp((i) => i.registerWaba({ accountId: accB.accountId, wabaId: "WABA_B2", metaAccessToken: "tok-x", provisioningStatus: "active", phones: [{ phoneNumberId: "PN_A1_1" }] })),
    ).rejects.toThrow(/already registered to another account/);

    await expect(
      cp((i) =>
        i.registerWabas([
          { accountId: accB.accountId, wabaId: "WABA_B3", metaAccessToken: "tok-b3", provisioningStatus: "active", phones: [{ phoneNumberId: "PN_B3_1" }] },
          { accountId: accB.accountId, wabaId: "WABA_B4", metaAccessToken: "tok-b4", provisioningStatus: "active", phones: [{ phoneNumberId: "PN_A1_1" }] },
        ]),
      ),
    ).rejects.toThrow(/already registered to another account/);

    await cp((i) => {
      const a = i.listAccountResources(accA.accountId);
      const b = i.listAccountResources(accB.accountId);
      expect(a.wabas.map((w) => w.wabaId).sort()).toEqual(["WABA_A1", "WABA_A2"]);
      expect(b.wabas.map((w) => w.wabaId).sort()).toEqual(["WABA_B1", "WABA_B2"]);
      expect(a.phones.map((p) => p.phoneNumberId).sort()).toEqual(["PN_A1_1", "PN_A2_1"]);
      const b2 = b.wabas.find((w) => w.wabaId === "WABA_B2")!;
      expect(b2.phones.map((p) => p.phoneNumberId)).toEqual(["PN_B2_1"]);
    });
  });

  it("preserves previously registered phones when a WABA is re-registered", async () => {
    const account = await createAccount("acc-upsert");
    await cp(async (i) => {
      await i.registerWaba({
        accountId: account.accountId,
        wabaId: "WABA_UPSERT",
        metaAccessToken: "token-v1",
        callbackUrl: "https://gateway.example/webhooks/meta",
        provisioningStatus: "active",
        phones: [
          { phoneNumberId: "PN_UPSERT_1", displayPhoneNumber: "+34 600 000 301" },
          { phoneNumberId: "PN_UPSERT_2", displayPhoneNumber: "+34 600 000 302" },
        ],
      });
      await i.registerWaba({
        accountId: account.accountId,
        wabaId: "WABA_UPSERT",
        metaAccessToken: "token-v2",
        provisioningStatus: "active",
        phones: [{ phoneNumberId: "PN_UPSERT_1", displayPhoneNumber: "+34 600 000 301" }],
      });
      expect(await i.getWaba(account.accountId, "WABA_UPSERT")).toMatchObject({
        metaAccessToken: "token-v2",
        callbackUrl: "https://gateway.example/webhooks/meta",
        phones: [
          { phoneNumberId: "PN_UPSERT_1" },
          { phoneNumberId: "PN_UPSERT_2" },
        ],
      });
    });
  });

  it("keeps an existing WABA's data plane when the account takes ownership", async () => {
    // Seeding a WABA's data plane directly mimics an object that already holds
    // history: registering it under an account must not create a new object.
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_MIGRATE"), async (gateway: EccosGateway) => {
      gateway.saveConfig({
        META_WABA_ID: "WABA_MIGRATE",
        META_PHONE_NUMBER_ID: "PN_MIGRATE",
        DISPLAY_PHONE_NUMBER: "+34 600 000 401",
        SUBSCRIBER_WEBHOOK_URL: "https://existing.example/webhook",
        SUBSCRIBER_SECRET: "existing-secret",
      });
      gateway.ingest([
        {
          type: "reply",
          from: "34600000401",
          messageId: "wamid.MIGRATE",
          text: "retained",
          at: 1_700_000_000_000,
          phoneNumberId: "PN_MIGRATE",
        },
      ]);
    });
    const account = await createAccountHttp("acc-migrate");
    const graph = mockGraph();
    const registration = await registerWabaHttp(
      account.accountId,
      "WABA_MIGRATE",
      "migrated-token",
      [{ phoneNumberId: "PN_MIGRATE", displayPhoneNumber: "+34 600 000 401" }],
      { subscriber_webhook_url: "https://existing.example/webhook", subscriber_secret: "existing-secret" },
    );
    expect(registration.status).toBe(202);

    // The account-scoped send uses the registry token and path.
    const send = await accountApi(account.apiKey)("/v1/wabas/WABA_MIGRATE/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "34600000401", type: "text", text: { body: "still live" } }),
    });
    expect(send.status).toBe(200);
    expect(graph.mock.calls.some(([input]) => String(input).includes("/PN_MIGRATE/messages"))).toBe(true);

    // The account-scoped webhook filter ingests a batch for the registered WABA/phone.
    const webhookBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "WABA_MIGRATE",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN_MIGRATE" },
            messages: [{ from: "34600000402", id: "wamid.MIGRATE_INGEST", timestamp: "1700000000", type: "text", text: { body: "retained" } }],
          },
        }],
      }],
    });
    const webhook = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: { "x-hub-signature-256": await signPayload(webhookBody, env.META_APP_SECRET) },
      body: webhookBody,
    });
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toEqual({ ok: true, received: 1 });

    const rpc = new GatewayRPC(createExecutionContext(), env);
    expect(await rpc.listInbound({ wabaId: "WABA_MIGRATE" }, account.accountId)).toHaveLength(2);
    // `toMatchObject`, not `toEqual`: this WABA has ingested an event, so the read
    // also carries `lastForward`, whose status depends on whether the drain alarm
    // has run yet. The target itself is what this assertion is about.
    const migratedCfg = await rpc.getSubscriberConfig("WABA_MIGRATE", account.accountId);
    expect(migratedCfg).toMatchObject({ url: "https://existing.example/webhook", hasSecret: true });
    expect(JSON.stringify(migratedCfg)).not.toContain("existing-secret");
    await cp(async (i) => expect((await i.getWaba(account.accountId, "WABA_MIGRATE"))?.metaAccessToken).toBe("migrated-token"));
    expect((await rpc.getStatus("WABA_MIGRATE", account.accountId)).connection.wabaId).toBe("WABA_MIGRATE");
  });

  it("keeps all RPC reads and actions inside the authenticated account scope", async () => {
    const accA = await createAccount("acc-rpc-a");
    const accB = await createAccount("acc-rpc-b");
    await cp(async (i) => {
      await i.registerWaba({
        accountId: accA.accountId,
        wabaId: "WABA_RPC_A",
        metaAccessToken: "token-rpc-a",
        provisioningStatus: "active",
        phones: [
          { phoneNumberId: "PN_RPC_A1", displayPhoneNumber: "+34 600 000 201" },
          { phoneNumberId: "PN_RPC_A2", displayPhoneNumber: "+34 600 000 202" },
        ],
      });
      await i.registerWaba({
        accountId: accB.accountId,
        wabaId: "WABA_RPC_B",
        metaAccessToken: "token-rpc-b",
        provisioningStatus: "active",
        phones: [{ phoneNumberId: "PN_RPC_B1", displayPhoneNumber: "+34 600 000 203" }],
      });
    });

    await runInDurableObject(getGatewayStubForWaba(env, "WABA_RPC_A"), async (gateway: EccosGateway) => {
      gateway.saveConfig({
        META_WABA_ID: "WABA_RPC_A",
        META_PHONE_NUMBER_ID: "PN_RPC_A1",
        META_ACCESS_TOKEN: "must-not-export",
        SUBSCRIBER_SECRET: "must-not-export",
      });
      gateway.ingest([
        {
          type: "reply",
          from: "34600000201",
          messageId: "wamid.RPC_A",
          text: "A",
          at: 1_700_000_000_000,
          phoneNumberId: "PN_RPC_A1",
        },
      ]);
      gateway.sql.exec("UPDATE deliveries SET status='failed' WHERE id = 1");
    });
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_RPC_B"), async (gateway: EccosGateway) => {
      gateway.saveConfig({ META_WABA_ID: "WABA_RPC_B", META_PHONE_NUMBER_ID: "PN_RPC_B1" });
      gateway.ingest([
        {
          type: "reply",
          from: "34600000203",
          messageId: "wamid.RPC_B",
          text: "B",
          at: 1_700_000_000_000,
          phoneNumberId: "PN_RPC_B1",
        },
      ]);
    });

    const rpc = new GatewayRPC(createExecutionContext(), env);
    const [aInbound, bInbound, aDeliveries, bExport] = await Promise.all([
      rpc.listInbound({ wabaId: "WABA_RPC_A" }, accA.accountId),
      rpc.listInbound({ wabaId: "WABA_RPC_B" }, accB.accountId),
      rpc.listDeliveries({ wabaId: "WABA_RPC_A" }, accA.accountId),
      rpc.exportData("WABA_RPC_B", accB.accountId),
    ]);
    expect(aInbound[0]).toMatchObject({ phone_number_id: "PN_RPC_A1" });
    expect(bInbound[0]).toMatchObject({ phone_number_id: "PN_RPC_B1" });
    expect(aDeliveries[0]).toMatchObject({ phone_number_id: "PN_RPC_A1", status: "failed" });
    expect(bExport.inbound[0]).toMatchObject({ phone_number_id: "PN_RPC_B1" });

    await expect(rpc.listInbound({ wabaId: "WABA_RPC_B" }, accA.accountId)).rejects.toThrow(/not owned/);
    await expect(rpc.listDeliveries({ wabaId: "WABA_RPC_B" }, accA.accountId)).rejects.toThrow(/not owned/);
    await expect(rpc.exportData("WABA_RPC_B", accA.accountId)).rejects.toThrow(/not owned/);
    await expect(rpc.retryDelivery(1, "WABA_RPC_B", accA.accountId)).rejects.toThrow(/not owned/);
    await expect(rpc.getSubscriberConfig("WABA_RPC_B", accA.accountId)).rejects.toThrow(/not owned/);

    expect(await rpc.retryDelivery(1, "WABA_RPC_A", accA.accountId)).toEqual({
      ok: true,
      previousStatus: "failed",
    });

    const deniedConcurrently = await Promise.all([
      rpc.listInbound({ wabaId: "WABA_RPC_B" }, accA.accountId).then(() => false, () => true),
      rpc.listOutbound({ wabaId: "WABA_RPC_B" }, accA.accountId).then(() => false, () => true),
      rpc.listDeliveries({ wabaId: "WABA_RPC_B" }, accA.accountId).then(() => false, () => true),
      rpc.getDelivery(1, "WABA_RPC_B", accA.accountId).then(() => false, () => true),
      rpc.retryDelivery(1, "WABA_RPC_B", accA.accountId).then(() => false, () => true),
      rpc.exportData("WABA_RPC_B", accA.accountId).then(() => false, () => true),
      rpc.getSubscriberConfig("WABA_RPC_B", accA.accountId).then(() => false, () => true),
      rpc.setSubscriberConfig({ url: "https://attacker.example", secret: "attacker-secret" }, "WABA_RPC_B", accA.accountId).then(() => false, () => true),
      rpc.resubscribe("WABA_RPC_B", accA.accountId).then((result) => !result.ok, () => true),
      rpc.eraseByPhone("34600000203", "WABA_RPC_B", accA.accountId).then(() => false, () => true),
    ]);
    expect(deniedConcurrently).toEqual(Array.from({ length: 10 }, () => true));

    const erased = await rpc.eraseByPhone("+34 600 000 201", "WABA_RPC_A", accA.accountId);
    expect(erased).toMatchObject({ ok: true, counts: { inboundEventsDeleted: 1, deliveriesDeleted: 1 } });
    const [aAfter, bAfter] = await Promise.all([
      rpc.listInbound({ wabaId: "WABA_RPC_A" }, accA.accountId),
      rpc.listInbound({ wabaId: "WABA_RPC_B" }, accB.accountId),
    ]);
    expect(aAfter).toHaveLength(0);
    expect(bAfter).toHaveLength(1);
  });

  it("bootstrapping an account never returns Meta credentials", async () => {
    const account = await cp((i) => i.createAccount({ accountId: "acc-boot", name: "Boot" }));
    const serialized = JSON.stringify(account);
    expect(serialized).not.toContain("META_ACCESS_TOKEN");
    expect(serialized).not.toContain("metaAccessToken");
    expect(serialized).not.toContain("test-access-token");
    expect(account.account).toEqual({ accountId: "acc-boot", name: "Boot", createdAt: expect.any(Number) });
    expect(account.apiKey.startsWith("ek_")).toBe(true);
    expect(account.keyId).toMatch(/^key_/);
  });

  it("maps an OAuth connect state to the initiating account and consumes it once", async () => {
    const { accountId } = await createAccount("acc-oauth");
    const state = "state-one-time";

    await cp((i) => i.startConnectState(state, accountId, Date.now() + 60_000));

    await cp((i) => {
      expect(i.consumeConnectStateForAccount(state, "acc-other")).toBeNull();
      expect(i.consumeConnectStateForAccount(state, accountId)).toEqual({
        accountId,
        redirectUri: null,
        returnTo: null,
      });
      expect(i.consumeConnectStateForAccount(state, accountId)).toBeNull();
    });

    await cp((i) => i.startConnectState("state-replay", accountId, Date.now() + 60_000));
    await cp((i) => {
      expect(i.consumeConnectState("state-replay")).toBe(accountId);
      expect(i.consumeConnectState("state-replay")).toBeNull();
    });

    const replay = await exports.default.fetch(`http://example.com/connect?code=oauth-code&state=${state}`);
    expect(replay.status).toBe(400);
  });

  it("authenticates admin bootstrap and isolates HTTP sends, templates, export, and erasure", async () => {
    const accA = await createAccountHttp("acc-http-a");
    const accB = await createAccountHttp("acc-http-b");
    const graph = mockGraph();
    const registeredA = await registerWabaHttp("acc-http-a", "WABA_HTTP_A", "token-a", [
      { phoneNumberId: "PN_HTTP_A1", displayPhoneNumber: "+34 600 000 101" },
      { phoneNumberId: "PN_HTTP_A2", displayPhoneNumber: "+34 600 000 102" },
    ], { subscriber_webhook_url: "https://tenant-a.example/webhook", subscriber_secret: "tenant-a-secret" });
    expect(registeredA.status).toBe(202);
    const registeredABody = await registeredA.json();
    expect(JSON.stringify(registeredABody)).not.toContain("tenant-a-secret");
    expect(await registerWabaHttp("acc-http-b", "WABA_HTTP_B", "token-b", [
      { phoneNumberId: "PN_HTTP_B1", displayPhoneNumber: "+34 600 000 103" },
    ])).toHaveProperty("status", 202);
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_HTTP_A"), async (gateway: EccosGateway) => {
      expect(gateway.getSubscriberConfig()).toEqual({
        url: "https://tenant-a.example/webhook",
        hasSecret: true,
        lastForward: null,
      });
    });

    const apiA = accountApi(accA.apiKey);
    const callsBeforeOwnRequests = graph.mock.calls.length;
    const foreignSend = await apiA("/v1/wabas/WABA_HTTP_B/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "34600000000", type: "text", text: { body: "nope" } }),
    });
    expect(foreignSend.status).toBe(404);
    expect(graph.mock.calls.length).toBe(callsBeforeOwnRequests);

    const ambiguous = await apiA("/v1/wabas/WABA_HTTP_A/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "34600000000", type: "text", text: { body: "ambiguous" } }),
    });
    expect(ambiguous.status).toBe(400);

    const ownSendA1 = await apiA("/v1/wabas/WABA_HTTP_A/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: "34600000000",
        phone_number_id: "PN_HTTP_A1",
        type: "text",
        text: { body: "hello from A1" },
      }),
    });
    expect(ownSendA1.status).toBe(200);

    const ownSend = await apiA("/v1/wabas/WABA_HTTP_A/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: "34600000000",
        phone_number_id: "PN_HTTP_A2",
        type: "text",
        text: { body: "hello" },
      }),
    });
    expect(ownSend.status).toBe(200);
    const sendCall = graph.mock.calls.find(([input]) => String(input).includes("/PN_HTTP_A2/messages"));
    expect(sendCall).toBeDefined();
    expect(JSON.parse(String(sendCall?.[1]?.body))).not.toHaveProperty("phone_number_id");
    expect(sendCall?.[1]?.headers).toMatchObject({ authorization: "Bearer token-a" });

    const apiB = accountApi(accB.apiKey);
    const ownSendB = await apiB("/v1/wabas/WABA_HTTP_B/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: "34600000000",
        phone_number_id: "PN_HTTP_B1",
        type: "text",
        text: { body: "hello from B" },
      }),
    });
    expect(ownSendB.status).toBe(200);
    const sendCallB = graph.mock.calls.find(([input]) => String(input).includes("/PN_HTTP_B1/messages"));
    expect(sendCallB?.[1]?.headers).toMatchObject({ authorization: "Bearer token-b" });

    await runInDurableObject(getGatewayStubForWaba(env, "WABA_HTTP_A"), async (gateway: EccosGateway) => {
      expect(gateway.listOutbound().map((row) => row.phone_number_id).sort()).toEqual([
        "PN_HTTP_A1",
        "PN_HTTP_A2",
      ]);
    });

    const mismatch = await apiA("/v1/wabas/WABA_HTTP_A/phones/PN_HTTP_A1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: "34600000000",
        phone_number_id: "PN_HTTP_A2",
        type: "text",
        text: { body: "mismatch" },
      }),
    });
    expect(mismatch.status).toBe(400);

    const foreignTemplates = await apiA("/v1/wabas/WABA_HTTP_B/templates");
    expect(foreignTemplates.status).toBe(404);
    const foreignExport = await apiA("/v1/wabas/WABA_HTTP_B/export");
    expect(foreignExport.status).toBe(404);
    const foreignErasure = await apiA("/v1/wabas/WABA_HTTP_B/privacy/erasure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "34600000000" }),
    });
    expect(foreignErasure.status).toBe(404);

    const unknownKey = accountApi("ek_unknown");
    expect((await unknownKey("/v1/wabas/WABA_HTTP_A/templates")).status).toBe(401);
    const revoke = await admin(`/v1/accounts/${accB.accountId}/keys/${accB.keyId}/revoke`, { method: "POST" });
    expect(revoke.status).toBe(200);
    expect((await accountApi(accB.apiKey)("/v1/wabas/WABA_HTTP_B/templates")).status).toBe(401);
  });

  it("filters webhooks by WABA and phone registered in the control plane", async () => {
    const account = await createAccountHttp("acc-webhook-http");
    mockGraph();
    const registration = await registerWabaHttp(account.accountId, "WABA_HOOK_HTTP", "token-hook", [
      { phoneNumberId: "PN_HOOK_HTTP_1", displayPhoneNumber: "+34 600 000 110" },
      { phoneNumberId: "PN_HOOK_HTTP_2", displayPhoneNumber: "+34 600 000 111" },
    ]);
    expect(registration.status).toBe(202);

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_HOOK_HTTP",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN_HOOK_HTTP_1" },
                messages: [{ from: "34600000000", id: "wamid.HOOK_HTTP", timestamp: "1700000000", type: "text", text: { body: "hello" } }],
              },
            },
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN_HOOK_HTTP_2" },
                messages: [{ from: "34600000003", id: "wamid.HOOK_HTTP_2", timestamp: "1700000000", type: "text", text: { body: "second phone" } }],
              },
            },
            {
              field: "messages",
              value: {
                messages: [{ from: "34600000002", id: "wamid.HOOK_HTTP_NO_PHONE", timestamp: "1700000000", type: "text", text: { body: "no phone metadata" } }],
              },
            },
          ],
        },
        {
          id: "WABA_UNKNOWN_HTTP",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN_UNKNOWN_HTTP" },
                messages: [{ from: "34600000001", id: "wamid.UNKNOWN_HTTP", timestamp: "1700000000", type: "text", text: { body: "ignore" } }],
              },
            },
          ],
        },
        {
          id: "WABA/INVALID_HTTP",
          changes: [
            {
              field: "messages",
              value: {
                messages: [{ from: "34600000004", id: "wamid.INVALID_HTTP", timestamp: "1700000000", type: "text", text: { body: "ignore malformed" } }],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const response = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, received: 3 });

    await runInDurableObject(getGatewayStubForWaba(env, "WABA_HOOK_HTTP"), async (gateway: EccosGateway) => {
      expect(gateway.getCounts().inbound).toBe(3);
      expect(gateway.listInbound().map((row) => row.phone_number_id).sort()).toEqual([
        "PN_HOOK_HTTP_1",
        "PN_HOOK_HTTP_2",
        null,
      ]);
      expect(gateway.listDeliveries().map((row) => row.phone_number_id).sort()).toEqual([
        "PN_HOOK_HTTP_1",
        "PN_HOOK_HTTP_2",
        null,
      ]);
    });
    await runInDurableObject(getGatewayStubForWaba(env, "WABA_UNKNOWN_HTTP"), async (gateway: EccosGateway) => {
      expect(gateway.getCounts().inbound).toBe(0);
    });
  });

  it("binds the Embedded Signup callback to the authenticated account", async () => {
    const account = await createAccountHttp("acc-connect-http");
    mockGraph();
    const handoff = await accountApi(account.apiKey)("/connect/start", {
      method: "POST",
    });
    expect(handoff.status).toBe(200);
    const handoffBody = (await handoff.json()) as { ok: true; url: string; expiresAt: number };
    expect(handoffBody.url).toContain("/connect?state=");
    expect(handoffBody.expiresAt).toBeGreaterThan(Date.now());

    // The handoff URL redirects straight to Meta's dialog, setting the CSRF
    // cookie on the way out (eccos-7jk).
    const start = await exports.default.fetch(handoffBody.url, { redirect: "manual" });
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toContain("/dialog/oauth?");
    const cookie = start.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    const state = cookie?.match(/eccos_connect_state=([^;]+)/)?.[1];
    expect(state).toBeTruthy();

    const callback = await exports.default.fetch(
      `https://example.com/connect?code=oauth-code&state=${encodeURIComponent(state ?? "")}`,
      { headers: { cookie: `eccos_connect_state=${state}` } },
    );
    // 200: the callback provisioned the WABA before answering (eccos-lpk).
    expect(callback.status).toBe(200);
    const callbackText = await callback.text();
    expect(callbackText).toContain("WABA_OAUTH");
    expect(callbackText).not.toContain("business-token");

    const reconciled = await admin(`/v1/accounts/${account.accountId}/wabas/WABA_OAUTH/reconcile`, { method: "POST" });
    expect(reconciled.status).toBe(200);

    await cp(async (i) => {
      expect(await i.getWaba(account.accountId, "WABA_OAUTH")).toMatchObject({
        accountId: account.accountId,
        metaAccessToken: "business-token",
        phones: [{ phoneNumberId: "PN_OAUTH" }],
      });
    });

    const replay = await exports.default.fetch(
      `https://example.com/connect?code=oauth-code&state=${encodeURIComponent(state ?? "")}`,
      { headers: { cookie: `eccos_connect_state=${state}` } },
    );
    expect(replay.status).toBe(400);
  });

  it("requires an account-bound state for direct OAuth exchange", async () => {
    const accountA = await createAccountHttp("acc-direct-exchange-a");
    const accountB = await createAccountHttp("acc-direct-exchange-b");
    const graph = mockGraph();
    const start = await accountApi(accountA.apiKey, "https://example.com")("/connect/start", { method: "POST" });
    const startBody = (await start.json()) as { state: string };

    const secureApiA = accountApi(accountA.apiKey, "https://example.com");
    const secureApiB = accountApi(accountB.apiKey, "https://example.com");
    const missingState = await secureApiA("/connect/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code" }),
    });
    expect(missingState.status).toBe(400);
    expect(graph).not.toHaveBeenCalled();

    const foreignState = await secureApiB("/connect/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", state: startBody.state }),
    });
    expect(foreignState.status).toBe(400);
    expect(graph).not.toHaveBeenCalled();

    const invalidRedirect = await secureApiA("/connect/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", state: startBody.state, redirect_uri: "https://attacker.example/connect" }),
    });
    expect(invalidRedirect.status).toBe(400);
    expect(graph).not.toHaveBeenCalled();

    const exchange = await secureApiA("/connect/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", state: startBody.state, redirect_uri: "https://example.com/connect" }),
    });
    expect(exchange.status).toBe(202);
    expect(await exchange.json()).toMatchObject({ ok: true, waba_id: "WABA_OAUTH" });
    // The exchange itself subscribes now (eccos-lpk); the targeted reconciler
    // behind it finds nothing to claim and never subscribes twice.
    const subscribed = () =>
      graph.mock.calls.filter(([input]) => String(input).includes("/WABA_OAUTH/subscribed_apps"));
    expect(subscribed()).toHaveLength(1);
    const reconciled = await admin(`/v1/accounts/${accountA.accountId}/wabas/WABA_OAUTH/reconcile`, { method: "POST" });
    expect(reconciled.status).toBe(200);
    expect(subscribed()).toHaveLength(1);
  });

  it("registers every WABA and phone returned by Embedded Signup", async () => {
    const account = await createAccountHttp("acc-connect-all");
    const graph = mockGraph([
      {
        wabaId: "WABA_OAUTH_A",
        phones: [
          { id: "PN_OAUTH_A1", display_phone_number: "+34 600 000 501" },
          { id: "PN_OAUTH_A2", display_phone_number: "+34 600 000 502" },
        ],
      },
      { wabaId: "WABA_OAUTH_B", phones: [{ id: "PN_OAUTH_B1", display_phone_number: "+34 600 000 503" }] },
    ]);
    const handoff = await accountApi(account.apiKey)("/connect/start", { method: "POST" });
    expect(handoff.status).toBe(200);
    const { url } = (await handoff.json()) as { url: string };
    const start = await exports.default.fetch(url, { redirect: "manual" });
    const state = start.headers.get("set-cookie")?.match(/eccos_connect_state=([^;]+)/)?.[1];
    expect(state).toBeTruthy();
    const callback = await exports.default.fetch(
      `https://example.com/connect?code=oauth-code&state=${encodeURIComponent(state ?? "")}`,
      { headers: { cookie: `eccos_connect_state=${state}` } },
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("PN_OAUTH_A2");

    const reconciled = await admin(`/v1/accounts/${account.accountId}/wabas/WABA_OAUTH_A/reconcile`, { method: "POST" });
    expect(reconciled.status).toBe(200);
    const reconciledB = await admin(`/v1/accounts/${account.accountId}/wabas/WABA_OAUTH_B/reconcile`, { method: "POST" });
    expect(reconciledB.status).toBe(200);

    await cp((i) => {
      const resources = i.listAccountResources(account.accountId);
      expect(resources.wabas.map((waba) => waba.wabaId)).toEqual(["WABA_OAUTH_A", "WABA_OAUTH_B"]);
      expect(resources.phones.map((phone) => phone.phoneNumberId)).toEqual([
        "PN_OAUTH_A1",
        "PN_OAUTH_A2",
        "PN_OAUTH_B1",
      ]);
    });
    const subscriptionCalls = graph.mock.calls.filter(([input]) => String(input).includes("/subscribed_apps"));
    expect(subscriptionCalls).toHaveLength(2);
    expect(subscriptionCalls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("/WABA_OAUTH_A/subscribed_apps"),
      expect.stringContaining("/WABA_OAUTH_B/subscribed_apps"),
    ]);
  });

  it("skips foreign WABAs returned alongside an available WABA", async () => {
    const account = await createAccountHttp("acc-connect-owned");
    const foreignAccount = await createAccountHttp("acc-connect-foreign");
    await cp(async (i) => {
      await i.registerWaba({
        accountId: foreignAccount.accountId,
        wabaId: "WABA_OAUTH_FOREIGN",
        metaAccessToken: "foreign-token",
        provisioningStatus: "active",
        phones: [{ phoneNumberId: "PN_OAUTH_FOREIGN", displayPhoneNumber: "+34 600 000 504" }],
      });
    });
    const graph = mockGraph([
      { wabaId: "WABA_OAUTH_FOREIGN", phones: [{ id: "PN_OAUTH_FOREIGN", display_phone_number: "+34 600 000 504" }] },
      { wabaId: "WABA_OAUTH_AVAILABLE", phones: [{ id: "PN_OAUTH_AVAILABLE", display_phone_number: "+34 600 000 505" }] },
    ]);

    const handoff = await accountApi(account.apiKey)("/connect/start", { method: "POST" });
    const { state } = (await handoff.json()) as { state: string };
    const exchange = await accountApi(account.apiKey)("/connect/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", state }),
    });
    expect(exchange.status).toBe(202);
    expect(await exchange.json()).toMatchObject({
      ok: true,
      waba_id: "WABA_OAUTH_AVAILABLE",
      warnings: [expect.stringContaining("WABA_OAUTH_FOREIGN")],
    });
    await cp(async (i) => {
      expect(await i.getWabaRecord(account.accountId, "WABA_OAUTH_AVAILABLE")).toMatchObject({ accountId: account.accountId });
      expect(await i.getWaba(foreignAccount.accountId, "WABA_OAUTH_FOREIGN")).toMatchObject({ accountId: foreignAccount.accountId });
    });

    const selectedHandoff = await accountApi(account.apiKey)("/connect/start", { method: "POST" });
    const { state: selectedState } = (await selectedHandoff.json()) as { state: string };
    const foreignSelection = await accountApi(account.apiKey)("/connect/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", state: selectedState, waba_id: "WABA_OAUTH_FOREIGN" }),
    });
    expect(foreignSelection.status).toBe(502);
    expect(await foreignSelection.json()).toEqual({
      ok: false,
      error: "waba \"WABA_OAUTH_FOREIGN\" is already registered to another account",
      code: "owned",
    });
    expect(graph.mock.calls.some(([input]) => String(input).includes("/oauth/access_token"))).toBe(true);
  });
});
