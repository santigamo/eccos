import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GatewayStatus } from "@eccos/gateway-contract";
import { StatusCounts, countTotal } from "../src/ui";
import { healthReading } from "../src/lib/health";

describe("Status page count maps", () => {
  test("countTotal sums a per-status map into the headline total", () => {
    expect(countTotal({ delivered: 3, failed: 1 })).toBe(4);
    expect(countTotal({})).toBe(0);
  });

  // StatusCounts with entries renders router Links, which need a RouterProvider;
  // the arithmetic is covered by countTotal above. Only the empty branch is
  // renderable standalone.
  test("StatusCounts renders an explicit empty state instead of a link row", () => {
    const html = renderToStaticMarkup(
      <StatusCounts label="outbound" counts={{}} target="outbound" />,
    );
    expect(html).toContain("No outbound recorded yet.");
    expect(html).not.toContain("<a");
  });
});

/**
 * What the Status page SAYS (`lib/health.ts`). Same reason the Webhooks suite
 * tests `lib/forwarding.ts` rather than the page: the banner's action is a
 * router `Link`, which needs a RouterProvider, while the sentence it carries is
 * a rule that has to hold.
 */
function status(overrides: Partial<GatewayStatus> = {}): GatewayStatus {
  return {
    name: "eccos",
    version: "1.0.0",
    health: "healthy",
    connection: { wabaId: "WABA1", phoneNumberId: "PN1", displayPhone: "+34600000000", connectedAt: null },
    counts: { inbound: 0, outbound: {}, deliveries: {} },
    ...overrides,
  };
}

describe("healthReading", () => {
  test("healthy raises no banner: the tag beside the heading already says it", () => {
    const reading = healthReading(status(), true);
    expect(reading.label).toBe("Healthy");
    expect(reading.banner).toBeNull();
  });

  test("degraded with a target keeps the generic capacity sentence", () => {
    const reading = healthReading(
      status({ health: "degraded", counts: { inbound: 0, outbound: {}, deliveries: { pending: 12 } } }),
      true,
    );
    expect(reading.banner?.detail).toBe("The gateway is running with reduced capacity.");
    expect(reading.banner?.action).toBeUndefined();
  });

  test("degraded with held rows and no target names the real state and the way out", () => {
    // THE POINT OF THIS MODULE. "Reduced capacity" describes a fault; a held
    // backlog is the gateway doing what it was told while an operator has not
    // named a receiver yet. The page must say which one it is.
    const reading = healthReading(
      status({ health: "degraded", counts: { inbound: 0, outbound: {}, deliveries: { pending: 12 } } }),
      false,
    );
    expect(reading.banner?.detail).toContain("12 events are waiting for a forwarding target");
    expect(reading.banner?.detail).not.toContain("reduced capacity");
    expect(reading.banner?.action).toEqual({ to: "/webhooks", label: "Set a forwarding target" });
  });

  test("one held event reads as one event, not '1 events'", () => {
    const reading = healthReading(
      status({ health: "degraded", counts: { inbound: 0, outbound: {}, deliveries: { pending: 1 } } }),
      false,
    );
    expect(reading.banner?.detail).toContain("1 event is waiting");
  });

  test("failed outbound sends keep the generic sentence, even with a held backlog", () => {
    // Two unrelated reasons for `degraded`; one sentence naming only the queue
    // would hide the other. The facts strip's red `failed` count carries it.
    const reading = healthReading(
      status({
        health: "degraded",
        counts: { inbound: 0, outbound: { failed: 3 }, deliveries: { pending: 12 } },
      }),
      false,
    );
    expect(reading.banner?.detail).toBe("The gateway is running with reduced capacity.");
    expect(reading.banner?.action).toBeUndefined();
  });

  test("unhealthy is never softened into a waiting message", () => {
    // A failed delivery is a real fault: a configured target that refuses keeps
    // failing, and no amount of missing configuration explains it away.
    const reading = healthReading(
      status({
        health: "unhealthy",
        counts: { inbound: 0, outbound: {}, deliveries: { failed: 2, pending: 20 } },
      }),
      false,
    );
    expect(reading.label).toBe("Unhealthy");
    expect(reading.banner?.detail).toBe("The gateway is experiencing an outage.");
  });
});
