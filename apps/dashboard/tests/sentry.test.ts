import { describe, expect, test } from "bun:test";
import { scrubBreadcrumb, scrubEvent, sentryOptions } from "../src/lib/sentry";

/** A URL fragment never reaches Sentry: on /connect it is the connection-link token. */
describe("Sentry scrubbing", () => {
  test("a navigation breadcrumb loses its fragments", () => {
    expect(
      scrubBreadcrumb({
        category: "navigation",
        data: { from: "/connect#sel.secret", to: "/connect", other: "#kept" },
      }),
    ).toEqual({ category: "navigation", data: { from: "/connect", to: "/connect", other: "#kept" } });
    expect(scrubBreadcrumb({ data: { url: "https://app.test/connect?x=1#sel.secret" } }).data).toEqual({
      url: "https://app.test/connect?x=1",
    });
    expect(scrubBreadcrumb({ message: "no data" })).toEqual({ message: "no data" });
  });

  test("an event loses them from its URL and from every breadcrumb it carries", () => {
    const event = scrubEvent({
      request: { url: "https://app.test/connect#sel.secret" },
      breadcrumbs: [{ data: { from: "/connect#sel.secret", to: "/numbers" } }],
    });
    expect(JSON.stringify(event)).not.toContain("sel.secret");
    expect(event.request.url).toBe("https://app.test/connect");
  });

  test("both hooks are installed for the browser and the server", () => {
    expect(sentryOptions.beforeBreadcrumb).toBe(scrubBreadcrumb);
    expect(sentryOptions.beforeSend).toBe(scrubEvent);
    expect(sentryOptions.beforeSendTransaction).toBe(scrubEvent);
  });
});
