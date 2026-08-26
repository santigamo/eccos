import { env } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { EccosGateway } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";

afterEach(async () => {
  await reset();
});

describe("WABA Durable Object routing", () => {
  it("keeps two WABAs in isolated objects with independent message ids", async () => {
    const a = getGatewayStubForWaba(env, "WABA_A");
    const b = getGatewayStubForWaba(env, "WABA_B");
    const event = {
      type: "reply" as const,
      from: "34600000000",
      messageId: "wamid.SAME",
      text: "hello",
      at: 1_700_000_000_000,
    };

    await runInDurableObject(a, async (gateway: EccosGateway) => {
      expect(gateway.ingest([event]).received).toBe(1);
      expect(gateway.getCounts().inbound).toBe(1);
    });
    await runInDurableObject(b, async (gateway: EccosGateway) => {
      expect(gateway.ingest([event]).received).toBe(1);
      expect(gateway.getCounts().inbound).toBe(1);
    });
  });
});
