import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { GatewayRPC } from "../../src/rpc";
import { bootstrapAccount, TEST_WABA_ID } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const ORG_ID = "org_scope";
const rpc = () => new GatewayRPC(createExecutionContext(), env);

const insertLink = (accountId: string, status = "active") =>
  runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
    cp.sql.exec(
      "INSERT INTO organization_accounts (organization_id, account_id, status, created_at) VALUES (?, ?, ?, ?)",
      ORG_ID,
      accountId,
      status,
      Date.now(),
    );
  });

async function linkedAccount(status = "active") {
  const { accountId } = await bootstrapAccount();
  await insertLink(accountId, status);
  return accountId;
}

describe("resolveOrganizationScope", () => {
  it("returns the linked account's resources without any credential", async () => {
    const accountId = await linkedAccount();
    const ctx = await rpc().resolveOrganizationScope(ORG_ID);
    expect(ctx.accountId).toBe(accountId);
    expect(ctx.resources.account?.accountId).toBe(accountId);
    expect(ctx.resources.wabas.map((w) => w.wabaId)).toEqual([TEST_WABA_ID]);
    expect(JSON.stringify(ctx)).not.toContain("tenant-token");
  });

  it("opens no stored token and makes a single link and resources read", async () => {
    await linkedAccount();
    const decrypt = vi.spyOn(EccosControlPlane.prototype as never, "decryptStoredToken");
    const getWaba = vi.spyOn(EccosControlPlane.prototype, "getWaba");
    const link = vi.spyOn(EccosControlPlane.prototype, "getOrganizationAccountLink");
    const resources = vi.spyOn(EccosControlPlane.prototype, "listAccountResources");
    await rpc().resolveOrganizationScope(ORG_ID);
    expect(link).toHaveBeenCalledTimes(1);
    expect(resources).toHaveBeenCalledTimes(1);
    expect(decrypt).not.toHaveBeenCalled();
    expect(getWaba).not.toHaveBeenCalled();
  });

  it("reconciles a missing link into one active account, idempotently", async () => {
    const first = await rpc().resolveOrganizationScope(ORG_ID);
    expect(first.resources.account?.accountId).toBe(first.accountId);
    expect(first.resources.wabas).toEqual([]);
    const second = await rpc().resolveOrganizationScope(ORG_ID);
    expect(second.accountId).toBe(first.accountId);
    expect(await rpc().getOrganizationAccountLink(ORG_ID)).toEqual({
      accountId: first.accountId,
      status: "active",
    });
  });

  it.each(["pending", "disabled"])("refuses a %s link", async (status) => {
    await linkedAccount(status);
    await expect(rpc().resolveOrganizationScope(ORG_ID)).rejects.toThrow(
      "This organization is not linked to an Eccos account",
    );
  });

  it("never exposes another account's WABA in the context", async () => {
    await linkedAccount();
    await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID2" }]);
    const ctx = await rpc().resolveOrganizationScope(ORG_ID);
    expect(ctx.resources.wabas.map((w) => w.wabaId)).toEqual([TEST_WABA_ID]);
  });
});

describe("read* fast path", () => {
  it("serves status and lists from the resolved WABA with no control-plane lookup", async () => {
    await linkedAccount();
    const { resources } = await rpc().resolveOrganizationScope(ORG_ID);
    const waba = resources.wabas[0]!;
    const getWaba = vi.spyOn(EccosControlPlane.prototype, "getWaba");
    const getRecord = vi.spyOn(EccosControlPlane.prototype, "getWabaRecord");
    const decrypt = vi.spyOn(EccosControlPlane.prototype as never, "decryptStoredToken");

    const status = await rpc().readStatus(waba);
    expect(status.connection).toMatchObject({
      wabaId: TEST_WABA_ID,
      phoneNumberId: "PNID1",
      displayPhone: "+34600000000",
    });
    expect(await rpc().readInbound(waba, {})).toEqual([]);
    expect(await rpc().readOutbound(waba, {})).toEqual([]);
    expect(await rpc().readDeliveries(waba, {})).toEqual([]);
    expect((await rpc().readConversations(waba, {})).items).toEqual([]);
    expect(await rpc().readSubscriberConfig(waba)).toMatchObject({ url: null });

    expect(getWaba).not.toHaveBeenCalled();
    expect(getRecord).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("matches the account-scoped getStatus", async () => {
    const accountId = await linkedAccount();
    const { resources } = await rpc().resolveOrganizationScope(ORG_ID);
    expect(await rpc().readStatus(resources.wabas[0]!)).toEqual(await rpc().getStatus(TEST_WABA_ID, accountId));
  });

  it("requires an account and a WABA", async () => {
    await expect(
      rpc().readStatus({ accountId: "", wabaId: TEST_WABA_ID, provisionedAt: null, phones: [] }),
    ).rejects.toThrow(/accountId is required/);
    await expect(
      rpc().readInbound({ accountId: "a", wabaId: " ", provisionedAt: null, phones: [] }, {}),
    ).rejects.toThrow(/wabaId is required/);
  });
});
