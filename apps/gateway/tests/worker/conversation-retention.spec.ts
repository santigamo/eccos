import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import {
  CONVERSATION_RETENTION_CONFIG_KEY,
  conversationRetentionConfigValue,
  conversationRetentionDays,
} from "../../src/conversation-retention";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount } from "./helpers";

const CALLBACK_URL = "https://example.test/webhook";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function rpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

function configOf(wabaId: string): Promise<string | null> {
  return runInDurableObject(getGatewayStubForWaba(env, wabaId), (instance) =>
    instance.getConfigValue(CONVERSATION_RETENTION_CONFIG_KEY),
  );
}

afterEach(async () => {
  await reset();
});

describe("conversationRetentionDays", () => {
  it("reads null and 'forever' as keep forever, and a day count as that window", () => {
    expect(conversationRetentionDays(null)).toBeNull();
    expect(conversationRetentionDays("forever")).toBeNull();
    expect(conversationRetentionDays("30")).toBe(30);
    expect(conversationRetentionDays("3650")).toBe(3650);
  });

  it("treats an unreadable value as forever rather than guessing a window", () => {
    for (const raw of ["", "0", "-5", "2.5", "soon"]) {
      expect(conversationRetentionDays(raw)).toBeNull();
    }
  });

  it("round-trips with conversationRetentionConfigValue", () => {
    expect(conversationRetentionDays(conversationRetentionConfigValue(null))).toBeNull();
    expect(conversationRetentionConfigValue(null)).toBe("forever");
    expect(conversationRetentionDays(conversationRetentionConfigValue(90))).toBe(90);
  });
});

describe("account conversation retention", () => {
  it("defaults to null (keep forever) for a new account", async () => {
    await bootstrapAccount("acct-a", "WABA_A");
    expect(await rpc().getConversationRetention("acct-a")).toBeNull();
  });

  it("stores valid windows and null, and rejects anything else", async () => {
    await bootstrapAccount("acct-a", "WABA_A");
    expect(await rpc().setConversationRetention("acct-a", 365)).toBe(365);
    expect(await rpc().getConversationRetention("acct-a")).toBe(365);
    expect(await rpc().setConversationRetention("acct-a", null)).toBeNull();
    expect(await rpc().getConversationRetention("acct-a")).toBeNull();

    for (const invalid of [29, 3651, 30.5, Number.NaN]) {
      await expect(rpc().setConversationRetention("acct-a", invalid)).rejects.toThrow(
        /invalid conversation retention/,
      );
    }
    // A rejected value never reaches storage.
    expect(await rpc().getConversationRetention("acct-a")).toBeNull();
  });

  it("accepts the bounds 30 and 3650", async () => {
    await bootstrapAccount("acct-a", "WABA_A");
    expect(await rpc().setConversationRetention("acct-a", 30)).toBe(30);
    expect(await rpc().setConversationRetention("acct-a", 3650)).toBe(3650);
  });

  it("writes the setting into the gateway config of every WABA the account owns", async () => {
    await bootstrapAccount("acct-a", "WABA_A");
    await bootstrapAccount("acct-a", "WABA_B", [{ phoneNumberId: "PNID_B" }]);
    expect(await configOf("WABA_A")).toBeNull();

    await rpc().setConversationRetention("acct-a", 90);
    expect(await configOf("WABA_A")).toBe("90");
    expect(await configOf("WABA_B")).toBe("90");

    await rpc().setConversationRetention("acct-a", null);
    expect(await configOf("WABA_A")).toBe("forever");
    expect(await configOf("WABA_B")).toBe("forever");
  });

  it("hands a WABA provisioned after the setting the account's current value", async () => {
    await bootstrapAccount("acct-a", "WABA_A");
    await rpc().setConversationRetention("acct-a", 180);

    await cp((instance) =>
      instance.beginWabaProvisioning({
        accountId: "acct-a",
        wabaId: "WABA_LATE",
        metaAccessToken: "tenant-token",
        callbackUrl: CALLBACK_URL,
        phones: [{ phoneNumberId: "PN_LATE" }],
      }),
    );
    const claim = await cp((instance) => instance.claimWabaProvisioning("acct-a", "WABA_LATE"));
    expect(claim?.conversationRetentionDays).toBe(180);
  });

  it("keeps each account's setting out of every other account's reach", async () => {
    await bootstrapAccount("acct-a", "WABA_A");
    await bootstrapAccount("acct-b", "WABA_B", [{ phoneNumberId: "PNID_B" }]);

    await rpc().setConversationRetention("acct-a", 30);
    expect(await rpc().getConversationRetention("acct-b")).toBeNull();
    expect(await configOf("WABA_B")).toBeNull();

    await rpc().setConversationRetention("acct-b", 3650);
    expect(await rpc().getConversationRetention("acct-a")).toBe(30);
    expect(await configOf("WABA_A")).toBe("30");
  });

  it("fails closed without an account, or for one that does not exist", async () => {
    await expect(rpc().getConversationRetention("")).rejects.toThrow(/accountId is required/);
    await expect(rpc().setConversationRetention("", 30)).rejects.toThrow(/accountId is required/);
    await expect(rpc().getConversationRetention("acct-missing")).rejects.toThrow(/does not exist/);
    await expect(rpc().setConversationRetention("acct-missing", 30)).rejects.toThrow(/does not exist/);
  });
});
