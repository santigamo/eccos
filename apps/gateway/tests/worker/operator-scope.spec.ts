import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayRPC } from "../../src/rpc";

const TEST_WABA_ID = "WABA_TEST";
const TEST_ACCOUNT_ID = "test-account";

afterEach(async () => {
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
});
