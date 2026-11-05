import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, gatewayStub, holdAlarms, TEST_ACCOUNT_ID } from "./helpers";

const ORG_ID = "org_broadcasts";
const org = { organizationId: ORG_ID };
const rpc = () => new GatewayRPC(createExecutionContext(), env);
let API_KEY = "";

beforeEach(async () => {
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
      return Response.json({ data: [{ name: "promo", language: "es", status: "APPROVED", id: "1" }] });
    }
    return Response.json({ messages: [{ id: "wamid.1" }] });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function create(numbers: string[]): Promise<string> {
  const res = await exports.default.fetch("http://example.com/v1/wabas/WABA_TEST/broadcasts", {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      template: { name: "promo", language: { code: "es" } },
      recipients: numbers.map((to) => ({ to })),
    }),
  });
  expect(res.status).toBe(202);
  const id = ((await res.json()) as { broadcast: { id: string } }).broadcast.id;
  // Distinct, ordered creation times so "newest first" is not a tie.
  await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
    instance.sql.exec(`UPDATE broadcasts SET created_at = ? WHERE id = ?`, 1_000 + instance.sql.exec(`SELECT COUNT(*) AS n FROM broadcasts`).toArray()[0]!.n, id);
  });
  return id;
}

describe("readBroadcasts", () => {
  it("lists newest first and pages with no overlap", async () => {
    const [a, b, c] = [await create(["34600000001"]), await create(["34600000002"]), await create(["34600000003"])];
    const first = await rpc().readBroadcasts(org, { limit: 2 });
    expect(first.scope.wabaId).toBe("WABA_TEST");
    expect(first.data.items.map((row) => row.id)).toEqual([c, b]);
    expect(first.data.nextCursor).toBe(b);
    const second = await rpc().readBroadcasts(org, { limit: 2, cursor: first.data.nextCursor ?? undefined });
    expect(second.data.items.map((row) => row.id)).toEqual([a]);
    expect(second.data.nextCursor).toBeNull();
  });

  it("an unknown cursor yields an empty page", async () => {
    await create(["34600000001"]);
    expect((await rpc().readBroadcasts(org, { cursor: "bc_gone" })).data).toEqual({ items: [], nextCursor: null });
  });

  it("refuses a WABA the organization's account does not own", async () => {
    await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID2" }]);
    await expect(rpc().readBroadcasts({ ...org, wabaId: "WABA_OTHER", rejectUnknown: true }, {})).rejects.toThrow(
      /WABA "WABA_OTHER" is not owned by account/,
    );
  });
});

describe("readBroadcast", () => {
  it("pages recipients by seq, filters by status, and keeps the stored error text", async () => {
    const id = await create(["34600000001", "34600000002", "34600000003"]);
    const envelope = JSON.stringify({ code: 131026, message: "Message undeliverable" });
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.sql.exec(`UPDATE broadcast_recipients SET status = 'failed', error = ? WHERE seq = 1`, envelope);
    });
    const first = (await rpc().readBroadcast(org, { broadcastId: id, limit: 2 })).data!;
    expect(first.recipients.items.map((row) => row.seq)).toEqual([0, 1]);
    expect(first.recipients.nextCursor).toBe("1");
    const second = (await rpc().readBroadcast(org, { broadcastId: id, limit: 2, cursor: "1" })).data!;
    expect(second.recipients.items.map((row) => row.seq)).toEqual([2]);
    expect(second.recipients.nextCursor).toBeNull();
    const failed = (await rpc().readBroadcast(org, { broadcastId: id, status: "failed" })).data!;
    expect(failed.recipients.items).toHaveLength(1);
    expect(JSON.parse(failed.recipients.items[0]!.error!)).toEqual({ code: 131026, message: "Message undeliverable" });
    expect(failed.broadcast).toMatchObject({ id, total: 3, counts: { failed: 1, queued: 2 } });
  });

  it("is null for another account's broadcast on the same WABA", async () => {
    const id = await create(["34600000001"]);
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
      instance.sql.exec(`UPDATE broadcasts SET account_id = 'other-account' WHERE id = ?`, id);
    });
    expect((await rpc().readBroadcast(org, { broadcastId: id })).data).toBeNull();
    expect((await rpc().readBroadcasts(org, {})).data.items).toEqual([]);
  });

  it("is null for an unknown id and throws on a bad status or cursor", async () => {
    const id = await create(["34600000001"]);
    expect((await rpc().readBroadcast(org, { broadcastId: "bc_nope" })).data).toBeNull();
    await expect(rpc().readBroadcast(org, { broadcastId: id, status: "bogus" as never })).rejects.toThrow(/invalid status/);
    await expect(rpc().readBroadcast(org, { broadcastId: id, cursor: "-1" })).rejects.toThrow(/invalid cursor/);
    await expect(rpc().readBroadcast(org, { broadcastId: id, cursor: "x" })).rejects.toThrow(/invalid cursor/);
  });
});

describe("cancelBroadcast", () => {
  it("cancels a running broadcast, is a no-op the second time, null for an unknown id", async () => {
    const id = await create(["34600000001", "34600000002"]);
    const input = { wabaId: "WABA_TEST", broadcastId: id };
    const done = await rpc().cancelBroadcast(input, TEST_ACCOUNT_ID);
    expect(done).toMatchObject({ status: "cancelled", counts: { cancelled: 2, queued: 0 } });
    expect(await rpc().cancelBroadcast(input, TEST_ACCOUNT_ID)).toMatchObject({ status: "cancelled" });
    expect(await rpc().cancelBroadcast({ ...input, broadcastId: "bc_nope" }, TEST_ACCOUNT_ID)).toBeNull();
  });

  it("throws for an account that does not own the WABA", async () => {
    const id = await create(["34600000001"]);
    await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID2" }]);
    await expect(
      rpc().cancelBroadcast({ wabaId: "WABA_TEST", broadcastId: id }, "other-account"),
    ).rejects.toThrow(/is not owned by account/);
    expect((await rpc().readBroadcast(org, { broadcastId: id })).data?.broadcast.status).toBe("running");
  });
});
