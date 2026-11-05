import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, gatewayStub, holdAlarms, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

const ORG_ID = "org_scheduled";
const org = { organizationId: ORG_ID };
const rpc = () => new GatewayRPC(createExecutionContext(), env);
const HOUR = 3600_000;
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

/** PUT a scheduled send, then pin its send time so the order under test is exact. */
async function put(key: string, sendAt: number, status?: string): Promise<void> {
  const res = await exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/scheduled/${key}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "34600000001", template: { name: "promo", language: { code: "es" } }, sendAt: Date.now() + HOUR }),
  });
  expect(res.status).toBe(201);
  await update(key, "send_at = ?, next_attempt_at = ?", sendAt, sendAt);
  if (status) await update(key, "status = ?", status);
}

async function update(key: string, set: string, ...params: (string | number)[]): Promise<void> {
  await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
    instance.sql.exec(`UPDATE scheduled_sends SET ${set} WHERE key = ?`, ...params, key);
  });
}

const keys = (page: { data: { items: { key: string }[] } }) => page.data.items.map((row) => row.key);

describe("readScheduled", () => {
  it("defaults to pending, soonest first, with every status counted, and pages without overlap", async () => {
    const base = Date.now() + HOUR;
    await put("e", base + 5);
    await put("c", base + 3);
    await put("a", base + 1);
    await put("d", base + 4);
    await put("b", base + 2);
    await put("done", base, "sent");

    const first = await rpc().readScheduled(org, { limit: 2 });
    expect(first.scope.wabaId).toBe(TEST_WABA_ID);
    expect(keys(first)).toEqual(["a", "b"]);
    expect(first.data.counts).toEqual({ pending: 5, sending: 0, sent: 1, failed: 0, unknown: 0, cancelled: 0 });
    const second = await rpc().readScheduled(org, { limit: 2, cursor: first.data.nextCursor ?? undefined });
    expect(keys(second)).toEqual(["c", "d"]);
    const last = await rpc().readScheduled(org, { limit: 2, cursor: second.data.nextCursor ?? undefined });
    expect(keys(last)).toEqual(["e"]);
    expect(last.data.nextCursor).toBeNull();
  });

  it("lists an ended status newest first and breaks ties on key", async () => {
    const base = Date.now() + HOUR;
    await put("old", base, "sent");
    await put("tie-a", base + 10, "sent");
    await put("tie-b", base + 10, "sent");
    await put("new", base + 20, "sent");
    const page = await rpc().readScheduled(org, { status: "sent", limit: 3 });
    expect(keys(page)).toEqual(["new", "tie-b", "tie-a"]);
    const rest = await rpc().readScheduled(org, { status: "sent", limit: 3, cursor: page.data.nextCursor ?? undefined });
    expect(keys(rest)).toEqual(["old"]);
  });

  it("neither lists nor counts another account's rows in the same WABA", async () => {
    await put("mine", Date.now() + HOUR);
    await put("theirs", Date.now() + HOUR);
    await update("theirs", "account_id = ?", "other-account");
    const page = await rpc().readScheduled(org, {});
    expect(keys(page)).toEqual(["mine"]);
    expect(page.data.counts.pending).toBe(1);
  });

  it("refuses a WABA the organization's account does not own", async () => {
    await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID2" }]);
    await expect(rpc().readScheduled({ ...org, wabaId: "WABA_OTHER", rejectUnknown: true }, {})).rejects.toThrow(
      /WABA "WABA_OTHER" is not owned by account/,
    );
  });

  it("throws on a bad status or cursor, and an unknown cursor yields an empty page", async () => {
    await put("a", Date.now() + HOUR);
    await expect(rpc().readScheduled(org, { status: "bogus" as never })).rejects.toThrow(/invalid status/);
    await expect(rpc().readScheduled(org, { cursor: "a/b" })).rejects.toThrow(/invalid cursor/);
    const gone = await rpc().readScheduled(org, { cursor: "gone" });
    expect(gone.data.items).toEqual([]);
    expect(gone.data.nextCursor).toBeNull();
  });

  it("keeps the stored error text for the console to parse", async () => {
    await put("bad", Date.now() + HOUR, "failed");
    const envelope = JSON.stringify({ code: 131026, message: "Message undeliverable" });
    await update("bad", "reason = 'rejected', error = ?", envelope);
    const row = (await rpc().readScheduled(org, { status: "failed" })).data.items[0]!;
    expect(row.failureReason).toBe("rejected");
    expect(JSON.parse(row.error!)).toEqual({ code: 131026, message: "Message undeliverable" });
  });
});

describe("cancelScheduled", () => {
  const input = (key: string) => ({ wabaId: TEST_WABA_ID, key });

  it("cancels a pending send, then reports unchanged", async () => {
    await put("a", Date.now() + HOUR);
    const done = await rpc().cancelScheduled(input("a"), TEST_ACCOUNT_ID);
    expect(done.state).toBe("cancelled");
    expect(done.scheduled?.status).toBe("cancelled");
    expect(keys(await rpc().readScheduled(org, { status: "cancelled" }))).toEqual(["a"]);
    expect((await rpc().cancelScheduled(input("a"), TEST_ACCOUNT_ID)).state).toBe("unchanged");
  });

  it("refuses a sent row, an unknown key and a bad key", async () => {
    await put("sent", Date.now() + HOUR, "sent");
    const late = await rpc().cancelScheduled(input("sent"), TEST_ACCOUNT_ID);
    expect(late.state).toBe("not_pending");
    expect(late.scheduled?.status).toBe("sent");
    expect((await rpc().cancelScheduled(input("nope"), TEST_ACCOUNT_ID)).state).toBe("missing");
    await expect(rpc().cancelScheduled(input("a/b"), TEST_ACCOUNT_ID)).rejects.toThrow(/invalid key/);
  });

  it("throws for an account that does not own the WABA", async () => {
    await put("a", Date.now() + HOUR);
    await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID2" }]);
    await expect(rpc().cancelScheduled(input("a"), "other-account")).rejects.toThrow(/is not owned by account/);
    expect(keys(await rpc().readScheduled(org, {}))).toEqual(["a"]);
  });
});
