import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";

const TEST_WABA_ID = "WABA_TEST";
const TEST_ACCOUNT_ID = "test-account";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("account-scoped operator RPC", () => {
  it("rejects a missing accountId on every method (fail closed)", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    const missingAccountId = undefined as unknown as string;
    for (const attempt of [
      () => rpc.getStatus(TEST_WABA_ID, missingAccountId),
      () => rpc.getConfig(TEST_WABA_ID, missingAccountId),
      () => rpc.listInbound({ wabaId: TEST_WABA_ID }, missingAccountId),
    ]) {
      const error = await attempt().then(() => null, (reason) => reason);
      expect(String(error?.message ?? error)).toMatch(/accountId is required/);
    }
  });

  it("fails closed for an unknown account on every stateful method", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    for (const attempt of [
      () => rpc.getStatus(TEST_WABA_ID, TEST_ACCOUNT_ID),
      () => rpc.getConfig(TEST_WABA_ID, TEST_ACCOUNT_ID),
      () => rpc.listDeliveries({ wabaId: TEST_WABA_ID }, TEST_ACCOUNT_ID),
      () => rpc.getDelivery(1, TEST_WABA_ID, TEST_ACCOUNT_ID),
      () => rpc.retryDelivery(1, TEST_WABA_ID, TEST_ACCOUNT_ID),
      () => rpc.getSubscriberConfig(TEST_WABA_ID, TEST_ACCOUNT_ID),
      () => rpc.setSubscriberConfig({ url: "https://attacker.example" }, TEST_WABA_ID, TEST_ACCOUNT_ID),
      () => rpc.eraseByPhone("34600000000", TEST_WABA_ID, TEST_ACCOUNT_ID),
      () => rpc.exportData(TEST_WABA_ID, TEST_ACCOUNT_ID),
    ]) {
      const error = await attempt().then(() => null, (reason) => reason);
      expect(String(error?.message ?? error)).toMatch(/does not exist|not owned/);
    }
    // Non-throwing shapes also fail closed.
    expect(await rpc.resubscribe(TEST_WABA_ID, TEST_ACCOUNT_ID)).toMatchObject({ ok: false });
    await expect(rpc.listTemplates(TEST_WABA_ID, 100, TEST_ACCOUNT_ID)).rejects.toThrow(/does not exist|not owned/);
  });

  it("opens WABA-LEVEL reads to a pending WABA while the data plane stays shut", async () => {
    // THE DELIBERATE ASYMMETRY. A WABA that connected without a phone number
    // stays `pending`, and it is exactly the tenant that wants to look at its
    // templates and set a forwarding target — both of which need only the WABA
    // id and its stored token. The data plane is a different matter: there is
    // no traffic, so `getStatus` and every other `getWaba` caller keeps
    // refusing. This test fails if that asymmetry is ever flattened either way.
    await runInDurableObject(getControlPlaneStub(env), async (cp) => {
      await cp.createAccount({ accountId: TEST_ACCOUNT_ID });
      await cp.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_AWAITING_PHONE",
        metaAccessToken: "tenant-token",
        provisioningStatus: "pending",
        phones: [],
      });
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const rpc = new GatewayRPC(createExecutionContext(), env);

    expect(await rpc.listTemplates("WABA_AWAITING_PHONE", 100, TEST_ACCOUNT_ID)).toMatchObject({
      ok: true,
    });
    expect(await rpc.getSubscriberConfig("WABA_AWAITING_PHONE", TEST_ACCOUNT_ID)).toMatchObject({
      hasSecret: false,
    });
    await rpc.setSubscriberConfig(
      { url: "https://subscriber.test/hook" },
      "WABA_AWAITING_PHONE",
      TEST_ACCOUNT_ID,
    );
    expect(await rpc.getSubscriberConfig("WABA_AWAITING_PHONE", TEST_ACCOUNT_ID)).toMatchObject({
      url: "https://subscriber.test/hook",
    });

    // Data plane, same WABA, same account: still refused.
    await expect(rpc.getStatus("WABA_AWAITING_PHONE", TEST_ACCOUNT_ID)).rejects.toThrow(/not owned/);
    await expect(rpc.exportData("WABA_AWAITING_PHONE", TEST_ACCOUNT_ID)).rejects.toThrow(/not owned/);

    // And ownership still binds on the widened path.
    await expect(
      rpc.listTemplates("WABA_AWAITING_PHONE", 100, "someone-else"),
    ).rejects.toThrow(/does not exist|not owned/);
  });
});
