export interface BillingEnv {
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_PRODUCT_ID?: string;
}

export interface BillingConfig {
  apiKey: string;
  webhookSecret: string;
  productId: string;
  apiUrl: string;
}

export function billingEnabled(env: BillingEnv): boolean {
  return Boolean(env.CREEM_API_KEY?.trim());
}

/** Null when billing is off, which is the default: no CREEM_API_KEY. */
export function billingConfig(env: BillingEnv): BillingConfig | null {
  const apiKey = env.CREEM_API_KEY?.trim();
  if (!apiKey) return null;
  const webhookSecret = env.CREEM_WEBHOOK_SECRET?.trim();
  const productId = env.CREEM_PRODUCT_ID?.trim();
  if (!webhookSecret || !productId) {
    throw new Error("CREEM_WEBHOOK_SECRET and CREEM_PRODUCT_ID are required when CREEM_API_KEY is set");
  }
  const apiUrl = apiKey.startsWith("creem_test_") ? "https://test-api.creem.io" : "https://api.creem.io";
  return { apiKey, webhookSecret, productId, apiUrl };
}
