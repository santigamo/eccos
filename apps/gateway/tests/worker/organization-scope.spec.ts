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

describe("organization-scoped read*", () => {
  const org = { organizationId: ORG_ID };

  it("is one control-plane hop and one data read: no getWaba, no token decryption", async () => {
    await linkedAccount();
    const resolve = vi.spyOn(EccosControlPlane.prototype, "resolveOrganizationContext");
    const getWaba = vi.spyOn(EccosControlPlane.prototype, "getWaba");
    const getRecord = vi.spyOn(EccosControlPlane.prototype, "getWabaRecord");
    const decrypt = vi.spyOn(EccosControlPlane.prototype as never, "decryptStoredToken");

    const { scope, data } = await rpc().readStatus(org);
    expect(scope).toMatchObject({ wabaId: TEST_WABA_ID });
    expect(scope.resources.wabas.map((w) => w.wabaId)).toEqual([TEST_WABA_ID]);
    expect(data.connection).toMatchObject({
      wabaId: TEST_WABA_ID,
      phoneNumberId: "PNID1",
      displayPhone: "+34600000000",
    });
    expect((await rpc().readInbound(org, {})).data).toEqual([]);
    expect((await rpc().readOutbound(org, {})).data).toEqual([]);
    expect((await rpc().readDeliveries(org, {})).data).toEqual([]);
    expect((await rpc().readConversations(org, {})).data.items).toEqual([]);
    expect((await rpc().readThreadView(org, { waId: "34600000001" })).data).toEqual({
      page: { items: [], nextCursor: null },
      contactName: null,
      reply: { phoneNumberId: null, lastInboundAt: null },
    });
    expect((await rpc().readSubscriberConfig(org)).data).toMatchObject({ url: null });

    expect(resolve).toHaveBeenCalledTimes(7);
    expect(getWaba).not.toHaveBeenCalled();
    expect(getRecord).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("matches the account-scoped getStatus", async () => {
    const accountId = await linkedAccount();
    expect((await rpc().readStatus(org)).data).toEqual(await rpc().getStatus(TEST_WABA_ID, accountId));
  });

  it("enforces ownership in the gateway: a foreign WABA is never read", async () => {
    await linkedAccount();
    await bootstrapAccount("other-account", "WABA_OTHER", [{ phoneNumberId: "PNID2" }]);
    const foreign = { ...org, wabaId: "WABA_OTHER" };
    // Falls back to the caller's own WABA, like the shared selection does...
    const { scope } = await rpc().readStatus(foreign);
    expect(scope.wabaId).toBe(TEST_WABA_ID);
    expect(scope.accountId).not.toBe("other-account");
    // ...and is refused outright when the caller asked for rejectUnknown.
    await expect(rpc().readConversations({ ...foreign, rejectUnknown: true }, {})).rejects.toThrow(
      /WABA "WABA_OTHER" is not owned by account/,
    );
  });

  it("keeps the active / any distinction for a pending WABA", async () => {
    const accountId = await linkedAccount();
    await runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
      cp.sql.exec("UPDATE wabas SET status = 'pending' WHERE account_id = ?", accountId);
    });
    await expect(rpc().readStatus(org)).rejects.toThrow(`WABA "${TEST_WABA_ID}" is still provisioning`);
    expect((await rpc().readSubscriberConfig({ ...org, mode: "any" })).scope.wabaId).toBe(TEST_WABA_ID);
  });

  it("keeps the link semantics: reconcile a missing link, refuse a disabled one", async () => {
    await expect(rpc().readStatus(org)).rejects.toThrow("has no registered WABAs");
    expect(await rpc().getOrganizationAccountLink(ORG_ID)).toMatchObject({ status: "active" });
    await runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
      cp.sql.exec("UPDATE organization_accounts SET status = 'disabled'");
    });
    await expect(rpc().readStatus(org)).rejects.toThrow("This organization is not linked to an Eccos account");
  });

  it("readDashboardState: null status without an active WABA, status with one", async () => {
    const empty = await rpc().readDashboardState(org);
    expect(empty.status).toBeNull();
    expect(empty.resources.wabas).toEqual([]);
    await reset();
    await linkedAccount();
    const ready = await rpc().readDashboardState(org);
    expect(ready.status?.scope.wabaId).toBe(TEST_WABA_ID);
    expect(ready.status?.data.connection.wabaId).toBe(TEST_WABA_ID);
  });

  it("requires an organization", async () => {
    await expect(rpc().readStatus({ organizationId: " " })).rejects.toThrow(/organizationId is required/);
  });
});
