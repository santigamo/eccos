#!/usr/bin/env node
// Reads, and with --set writes, one account's billing status in production
// (docs/operations.md#billing-status). Runs under Node: Bun hangs on the remote proxy.
//   bun run ops:billing <organizationId|accountId> [--set <status>]
import type { GatewayRPC } from "../packages/gateway-contract/src/index.ts";
import { BILLING_STATUSES, isBillingStatus } from "../packages/gateway-contract/src/billing-status.ts";
import { getPlatformProxy } from "wrangler";

const [id, flag, status] = process.argv.slice(2);
if (!id || (flag !== undefined && (flag !== "--set" || !isBillingStatus(status)))) {
  console.error(`usage: bun run ops:billing <organizationId|accountId> [--set ${BILLING_STATUSES.join("|")}]`);
  process.exit(2);
}

const proxy = await getPlatformProxy<{ GATEWAY: GatewayRPC }>({
  configPath: new URL("ops.wrangler.jsonc", import.meta.url).pathname,
  envFiles: [],
  persist: false,
});
try {
  const gateway = proxy.env.GATEWAY;
  let accountId = id;
  if (!id.startsWith("acc_")) {
    const link = await gateway.getOrganizationAccountLink(id);
    console.log("link", JSON.stringify(link));
    if (!link) throw new Error(`no account for organization ${id}`);
    accountId = link.accountId;
  }
  // RPC results arrive as proxy stubs; JSON reads their fields.
  console.log("billing", accountId, JSON.stringify(await gateway.getAccountBilling(accountId)));
  if (status) {
    const updated = await gateway.setAccountBilling(accountId, { billingStatus: status });
    console.log("updated", accountId, JSON.stringify(updated));
  }
} finally {
  await proxy.dispose();
}
