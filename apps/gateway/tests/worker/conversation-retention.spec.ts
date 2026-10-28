import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import type { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, gatewayStub } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;
const WA_OLD = "15550000001";
const WA_RECENT = "15550000002";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function rpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

function seedMessage(instance: EccosGateway, waId: string, ageDays: number): void {
  const at = Date.now() - ageDays * DAY_MS;
  instance.sql.exec(
    `INSERT INTO messages (id, wa_id, direction, origin, type, text, content, at, status, created_at)
     VALUES (?, ?, 'in', 'live', 'text', 'hello', NULL, ?, NULL, ?)`,
    `wamid.${waId}.${ageDays}`,
    waId,
    at,
    at,
  );
  instance.sql.exec(
    `INSERT OR IGNORE INTO contacts (wa_id, name, source, updated_at) VALUES (?, NULL, 'live', ?)`,
    waId,
    at,
  );
}

function countOf(instance: EccosGateway, table: "messages" | "contacts", waId?: string): number {
  const where = waId ? "WHERE wa_id = ?" : "";
  const args = waId ? [waId] : [];
  return Number(
    instance.sql.exec(`SELECT COUNT(*) AS c FROM ${table} ${where}`, ...args).toArray()[0]!.c,
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("account conversation retention", () => {
  beforeEach(async () => {
    await bootstrapAccount("acct-a", "WABA_A");
  });

  it("defaults to null (keep forever) for a new account", async () => {
    expect(await rpc().getConversationRetention("acct-a")).toBeNull();
  });

  it("stores valid windows and null, and rejects anything else", async () => {
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
    expect(await rpc().setConversationRetention("acct-a", 30)).toBe(30);
    expect(await rpc().setConversationRetention("acct-a", 3650)).toBe(3650);
  });

  it("answers a WABA's retention from its account, and refuses an unknown WABA", async () => {
    await bootstrapAccount("acct-b", "WABA_B", [{ phoneNumberId: "PNID_B" }]);
    await rpc().setConversationRetention("acct-a", 90);

    expect(await cp((i) => i.getConversationRetentionDaysForWaba("WABA_A"))).toBe(90);
    expect(await cp((i) => i.getConversationRetentionDaysForWaba("WABA_B"))).toBeNull();
    await expect(cp((i) => i.getConversationRetentionDaysForWaba("WABA_MISSING"))).rejects.toThrow(
      /does not exist/,
    );
  });

  it("keeps each account's setting out of every other account's reach", async () => {
    await bootstrapAccount("acct-b", "WABA_B", [{ phoneNumberId: "PNID_B" }]);

    await rpc().setConversationRetention("acct-a", 30);
    expect(await rpc().getConversationRetention("acct-b")).toBeNull();

    await rpc().setConversationRetention("acct-b", 3650);
    expect(await rpc().getConversationRetention("acct-a")).toBe(30);
  });

  it("fails closed without an account, or for one that does not exist", async () => {
    await expect(rpc().getConversationRetention("")).rejects.toThrow(/accountId is required/);
    await expect(rpc().setConversationRetention("", 30)).rejects.toThrow(/accountId is required/);
    await expect(rpc().getConversationRetention("acct-missing")).rejects.toThrow(/does not exist/);
    await expect(rpc().setConversationRetention("acct-missing", 30)).rejects.toThrow(/does not exist/);
  });
});

describe("conversation retention sweep", () => {
  beforeEach(async () => {
    await bootstrapAccount();
  });

  it("deletes messages older than the window and keeps the recent ones", async () => {
    await rpc().setConversationRetention("test-account", 30);
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      seedMessage(i, WA_OLD, 40);
      seedMessage(i, WA_RECENT, 5);
      seedMessage(i, WA_RECENT, 45);

      await i.alarm();

      expect(countOf(i, "messages", WA_OLD)).toBe(0);
      expect(countOf(i, "messages", WA_RECENT)).toBe(1);
    });
  });

  it("deletes a contact once it has no message left, and keeps one that still has a message", async () => {
    await rpc().setConversationRetention("test-account", 30);
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      seedMessage(i, WA_OLD, 40);
      seedMessage(i, WA_RECENT, 5);

      await i.pruneConversations(Date.now());

      expect(countOf(i, "contacts", WA_OLD)).toBe(0);
      expect(countOf(i, "contacts", WA_RECENT)).toBe(1);
    });
  });

  it("keeps everything when the window is forever (NULL)", async () => {
    await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      seedMessage(i, WA_OLD, 4000);
      seedMessage(i, WA_RECENT, 5);

      await i.pruneConversations(Date.now());

      expect(countOf(i, "messages")).toBe(2);
      expect(countOf(i, "contacts")).toBe(2);
    });
  });

  it("deletes nothing and logs when the window lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orphanStub = getGatewayStubForWaba(env, "WABA_UNREGISTERED");
    await runInDurableObject(orphanStub, async (i: EccosGateway) => {
      seedMessage(i, WA_OLD, 4000);

      await i.pruneConversations(Date.now());

      expect(countOf(i, "messages")).toBe(1);
      expect(countOf(i, "contacts")).toBe(1);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"lookup-failed"'));
  });
});
