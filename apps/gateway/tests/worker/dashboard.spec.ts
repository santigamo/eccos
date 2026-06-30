import { describe, expect, it } from "vitest";
import { computeHealth } from "../../src/routes/dashboard";

describe("computeHealth", () => {
  it("returns unhealthy when a delivery failed", () => {
    expect(
      computeHealth({
        deliveries: [{ status: "failed" }],
        outbound: [],
      }),
    ).toBe("unhealthy");
  });

  it("returns degraded when pending backlog exceeds 10", () => {
    expect(
      computeHealth({
        deliveries: Array.from({ length: 11 }, () => ({ status: "pending" })),
        outbound: [],
      }),
    ).toBe("degraded");
  });

  it("returns degraded when recent outbound send failed", () => {
    expect(
      computeHealth({
        deliveries: [],
        outbound: [{ status: "failed" }],
      }),
    ).toBe("degraded");
  });

  it("returns healthy when no failures or large backlog", () => {
    expect(
      computeHealth({
        deliveries: [{ status: "pending" }],
        outbound: [{ status: "sent" }],
      }),
    ).toBe("healthy");
  });
});
