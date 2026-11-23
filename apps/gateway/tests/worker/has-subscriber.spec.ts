import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

afterEach(async () => {
  await reset();
});

const message = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => String(error));

describe("GatewayRPC.hasSubscriber", () => {
  it("answers only whether the WABA has a forwarding target", async () => {
    await bootstrapAccount();
    const rpc = new GatewayRPC(createExecutionContext(), env);

    expect(await rpc.hasSubscriber(TEST_WABA_ID, TEST_ACCOUNT_ID)).toBe(false);
    await rpc.setSubscriberConfig({ url: "https://hooks.acme.example/wa", secret: "s3cret" }, TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(await rpc.hasSubscriber(TEST_WABA_ID, TEST_ACCOUNT_ID)).toBe(true);
    await rpc.setSubscriberConfig({ url: null }, TEST_WABA_ID, TEST_ACCOUNT_ID);
    expect(await rpc.hasSubscriber(TEST_WABA_ID, TEST_ACCOUNT_ID)).toBe(false);
  });

  it("checks WABA ownership exactly as getSubscriberConfig does", async () => {
    await bootstrapAccount();
    const rpc = new GatewayRPC(createExecutionContext(), env);

    for (const [wabaId, accountId] of [
      [TEST_WABA_ID, "acc_someone_else"],
      ["WABA_NOT_REGISTERED", TEST_ACCOUNT_ID],
    ] as const) {
      const refused = await message(rpc.hasSubscriber(wabaId, accountId));
      expect(refused).not.toBeNull();
      expect(refused).toBe(await message(rpc.getSubscriberConfig(wabaId, accountId)));
    }
  });
});
