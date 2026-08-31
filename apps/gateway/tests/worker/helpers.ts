import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { getControlPlaneStub } from "../../src/control-plane-stub";

export const TEST_WABA_ID = "WABA_TEST";
export const TEST_ACCOUNT_ID = "test-account";

export function gatewayStub() {
  return getGatewayStubForWaba(env, env.META_WABA_ID ?? TEST_WABA_ID);
}

export function metaEnvelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: TEST_WABA_ID, changes: [{ field: "messages", value }] }],
  };
}

/** Test subscriber forwarding target (set in DO config — no env fallback). */
export const SUBSCRIBER_URL = "https://subscriber.test/webhook";
export const SUBSCRIBER_SECRET = "test-subscriber-secret";

/**
 * Bootstraps the account-scoped surface for a test: creates the account in the
 * control plane and registers the WABA/phones under it, so RPC and HTTP (`/v1/*`)
 * operations resolve tenant credentials from the registry. Each test starts from
 * a clean Durable Object (the pool's `reset()` after `afterEach`), so calling
 * this per test is idempotent-in-practice.
 */
export async function bootstrapAccount(
  accountId = TEST_ACCOUNT_ID,
  wabaId = TEST_WABA_ID,
  phones?: Array<{ phoneNumberId: string; displayPhoneNumber?: string }>,
): Promise<{ accountId: string; wabaId: string; apiKey: string }> {
  const usedPhones =
    phones ?? [{ phoneNumberId: "PNID1", displayPhoneNumber: "+34600000000" }];
  const result = await runInDurableObject(getControlPlaneStub(env), async (cp) => {
    const account = cp.sql.exec("SELECT account_id FROM accounts WHERE account_id = ?", accountId).toArray()[0];
    if (!account) {
      const created = await cp.createAccount({ accountId });
      await cp.registerWaba({ accountId, wabaId, metaAccessToken: "tenant-token", provisioningStatus: "active", phones: usedPhones });
      return created.apiKey;
    }
    await cp.registerWaba({ accountId, wabaId, metaAccessToken: "tenant-token", provisioningStatus: "active", phones: usedPhones });
    return null;
  });
  return { accountId, wabaId, apiKey: result ?? "ek-account-key" };
}
