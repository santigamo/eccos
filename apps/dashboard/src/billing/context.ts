import type { GatewayApi } from "@eccos/gateway-contract";
import { billingConfig, type BillingConfig, type BillingEnv } from "./config";
import { creemClient, type Creem } from "./creem";

export interface Billing {
  config: BillingConfig;
  creem: Creem;
  gateway: GatewayApi;
}

/** What every billing entry point works with, or null when billing is off. */
export function billingFor(env: BillingEnv & { GATEWAY: GatewayApi }): Billing | null {
  const config = billingConfig(env);
  return config ? { config, creem: creemClient(config), gateway: env.GATEWAY } : null;
}
