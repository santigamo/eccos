import { env } from "cloudflare:workers";

export function singletonStub() {
  return env.ECCOS.get(env.ECCOS.idFromName("singleton"));
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export function metaEnvelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_TEST", changes: [{ field: "messages", value }] }],
  };
}
