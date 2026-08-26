import { env } from "cloudflare:workers";
import { getGatewayStubForWaba } from "../../src/gateway-stub";

export function gatewayStub() {
  return getGatewayStubForWaba(env, env.META_WABA_ID);
}

export function metaEnvelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_TEST", changes: [{ field: "messages", value }] }],
  };
}
