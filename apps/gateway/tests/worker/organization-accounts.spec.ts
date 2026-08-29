import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";

afterEach(async () => {
  await reset();
});

const ORG_ID = "org_abc123";

describe("organization_accounts mapping (contract §2)", () => {
  it("creates an account and an active link without issuing an API key", async () => {
    const stub = getControlPlaneStub(env);
    const result = await runInDurableObject(stub, async (cp: EccosControlPlane) =>
      cp.ensureOrganizationAccount(ORG_ID, "Acme"),
    );
    expect(result.status).toBe("active");
    expect(result.accountId).toMatch(/^acc_/);

    const resources = await stub.listAccountResources(result.accountId);
    expect(resources.account?.accountId).toBe(result.accountId);
    // Contract invariant: provisioning must NOT auto-issue an API key.
    expect(resources.keys).toEqual([]);

    const link = await stub.getOrganizationAccountLink(ORG_ID);
    expect(link).toEqual({ accountId: result.accountId, status: "active" });
  });

  it("is idempotent: repeated ensures return the same account without new rows", async () => {
    const stub = getControlPlaneStub(env);
    const first = await runInDurableObject(stub, async (cp: EccosControlPlane) =>
      cp.ensureOrganizationAccount(ORG_ID),
    );
    const second = await runInDurableObject(stub, async (cp: EccosControlPlane) =>
      cp.ensureOrganizationAccount(ORG_ID),
    );
    expect(second).toEqual({ accountId: first.accountId, status: "existing" });
    await runInDurableObject(stub, async (cp: EccosControlPlane) => {
      const rows = cp.sql
        .exec("SELECT COUNT(*) AS n FROM accounts")
        .toArray();
      expect(rows[0].n).toBe(1);
      const links = cp.sql
        .exec("SELECT COUNT(*) AS n FROM organization_accounts")
        .toArray();
      expect(links[0].n).toBe(1);
    });
  });

  it("creates distinct accounts for distinct organizations (one-to-one)", async () => {
    const stub = getControlPlaneStub(env);
    const a = await runInDurableObject(stub, async (cp: EccosControlPlane) =>
      cp.ensureOrganizationAccount("org_aaa"),
    );
    const b = await runInDurableObject(stub, async (cp: EccosControlPlane) =>
      cp.ensureOrganizationAccount("org_bbb"),
    );
    expect(a.accountId).not.toBe(b.accountId);
    await runInDurableObject(stub, async (cp: EccosControlPlane) => {
      // Storage-level one-to-one: a second org cannot claim the same account.
      expect(
        () =>
          cp.sql.exec(
            "INSERT INTO organization_accounts (organization_id, account_id, status, created_at) VALUES ('org_ccc', ?, 'active', 1)",
            a.accountId,
          ),
      ).toThrow();
    });
  });

  it("returns null for an unknown organization", async () => {
    const stub = getControlPlaneStub(env);
    const link = await stub.getOrganizationAccountLink("org_unknown");
    expect(link).toBeNull();
  });

  it("rejects invalid organization ids (fail closed)", async () => {
    const stub = getControlPlaneStub(env);
    await runInDurableObject(stub, async (cp: EccosControlPlane) => {
      expect(() => cp.getOrganizationAccountLink("")).toThrow(/invalid organizationId/);
      expect(() =>
        cp.getOrganizationAccountLink("bad org id with spaces"),
      ).toThrow(/invalid organizationId/);
      expect(() => cp.getOrganizationAccountLink("x".repeat(200))).toThrow(
        /invalid organizationId/,
      );
    });
  });
});
