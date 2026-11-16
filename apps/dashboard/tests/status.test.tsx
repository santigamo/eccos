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
    expect(reading.banners).toEqual([]);
  });

  test("degraded with a target keeps the generic capacity sentence", () => {
    const reading = healthReading(
      status({ health: "degraded", counts: { inbound: 0, outbound: {}, deliveries: { pending: 12 } } }),
      true,
    );
    expect(reading.banners[0]?.detail).toBe("The gateway is running with reduced capacity.");
    expect(reading.banners[0]?.action).toBeUndefined();
  });

  test("degraded with held rows and no target names the real state and the way out", () => {
    // THE POINT OF THIS MODULE. "Reduced capacity" describes a fault; a held
    // backlog is the gateway doing what it was told while an operator has not
    // named a receiver yet. The page must say which one it is.
    const reading = healthReading(
      status({ health: "degraded", counts: { inbound: 0, outbound: {}, deliveries: { pending: 12 } } }),
      false,
    );
    expect(reading.banners[0]?.detail).toContain("12 events are waiting for a forwarding target");
    expect(reading.banners[0]?.detail).not.toContain("reduced capacity");
    expect(reading.banners[0]?.action).toEqual({ to: "/webhooks", label: "Set a forwarding target" });
  });

  test("held events raise the banner under a Healthy tag, with the deadline", () => {
    // Nine held events is below the gateway's `degraded` threshold. A first
    // customer sat under a green tag with exactly that many.
    const nine = status({ counts: { inbound: 0, outbound: {}, deliveries: { pending: 9 } } });
    const reading = healthReading(nine, false, 30);
    expect(reading.label).toBe("Healthy");
    // The deadline runs per event from its arrival, and saving a target is
    // what sends them: without that half an operator reads "lost".
    expect(reading.banners[0]?.detail).toBe(
      "9 events are waiting for a forwarding target. Save one and they are sent right away. Each is deleted 30 days after it arrived.",
    );
    expect(reading.banners[0]?.action).toEqual({ to: "/webhooks", label: "Set a forwarding target" });
    expect(healthReading(nine, true, 30).banners).toEqual([]);
  });

  test("a target read that failed is unknown, and unknown raises nothing", () => {
    // `null` is a failed read. The banner fires at one pending row, so reading
    // it as "no target" would tell an account WITH a target to go set one.
    const queued = status({ counts: { inbound: 0, outbound: {}, deliveries: { pending: 3 } } });
    expect(healthReading(queued, null, 30).banners).toEqual([]);
  });

  test("one held event reads as one event, not '1 events'", () => {
    const reading = healthReading(
      status({ health: "degraded", counts: { inbound: 0, outbound: {}, deliveries: { pending: 1 } } }),
      false,
    );
    expect(reading.banners[0]?.detail).toContain("1 event is waiting");
  });

  test("failed outbound sends keep their own line and their own door", () => {
    // With a target there is nothing held: the only fact is the sends Meta
    // refused, and its door is the failed messages, not the Webhooks page.
    const reading = healthReading(
      status({ health: "degraded", counts: { inbound: 0, outbound: { failed: 3 }, deliveries: {} } }),
      true,
      30,
    );
    expect(reading.banners).toEqual([
      {
        detail: "3 messages failed to send.",
        rail: "border-l-warning",
        action: { to: "/messages", label: "Open the failed messages", search: { status: "failed" } },
      },
    ]);
  });

  test("failed outbound sends and a held backlog are two lines, each with its action", () => {
    const reading = healthReading(
      status({
        health: "degraded",
        counts: { inbound: 0, outbound: { failed: 1 }, deliveries: { pending: 12 } },
      }),
      false,
      30,
    );
    expect(reading.banners.map((banner) => banner.action?.to)).toEqual(["/messages", "/webhooks"]);
    expect(reading.banners[0]?.detail).toBe("1 message failed to send.");
    expect(reading.banners[1]?.detail).toContain("12 events are waiting for a forwarding target");
    expect(reading.banners[1]?.detail).not.toContain("failed");
  });

  test("an unhealthy gateway still says what is held, with the deadline", () => {
    // Failed forwards do not make held events any less deletable. A target
    // removed after failures leaves both facts standing, each with its door.
    const reading = healthReading(
      status({
        health: "unhealthy",
        counts: { inbound: 0, outbound: {}, deliveries: { failed: 2, pending: 20 } },
      }),
      false,
      30,
    );
    expect(reading.banners.map((banner) => banner.rail)).toEqual(["border-l-destructive", "border-l-warning"]);
    expect(reading.banners[0]?.action).toEqual({ to: "/deliveries", label: "Open the forwarding queue" });
    expect(reading.banners[1]?.detail).toBe(
      "20 events are waiting for a forwarding target. Save one and they are sent right away. Each is deleted 30 days after it arrived.",
    );
    expect(reading.banners[1]?.action).toEqual({ to: "/webhooks", label: "Set a forwarding target" });
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
    expect(reading.banners[0]?.detail).toBe(
      "2 forwarded batches failed after every retry. Check your server, then retry them from the forwarding queue.",
    );
    expect(reading.banners[0]?.action).toEqual({ to: "/deliveries", label: "Open the forwarding queue" });
  });
});
