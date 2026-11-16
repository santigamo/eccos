import { describe, expect, test } from "bun:test";
import { scrubFragments, sentryOptions } from "../src/lib/sentry";

/** A URL fragment never reaches Sentry: on /connect it is the connection-link token. */
describe("Sentry scrubbing", () => {
  test("a navigation breadcrumb loses its fragments", () => {
    expect(
      scrubFragments({
        category: "navigation",
        data: { from: "/connect#sel.secret", to: "/connect", note: "#kept, not a URL" },
      }),
    ).toEqual({ category: "navigation", data: { from: "/connect", to: "/connect", note: "#kept, not a URL" } });
    expect(scrubFragments({ data: { url: "https://app.test/connect?x=1#sel.secret" } }).data).toEqual({
      url: "https://app.test/connect?x=1",
    });
  });

  test("a transaction loses them from its name, its spans and its contexts", () => {
    const transaction = scrubFragments({
      type: "transaction",
      transaction: "GET /connect#sel.secret",
      request: { url: "https://app.test/connect#sel.secret" },
      contexts: { trace: { data: { "url.full": "https://app.test/connect#sel.secret", "url.fragment": "sel.secret" } } },
      spans: [
        { description: "navigation /connect#sel.secret", data: { "http.url": "/connect#sel.secret", "http.fragment": "sel.secret" } },
      ],
      breadcrumbs: [{ data: { from: "/connect#sel.secret", to: "/numbers" } }],
    });
    expect(JSON.stringify(transaction)).not.toContain("sel.secret");
    expect(transaction.transaction).toBe("GET /connect");
    expect(transaction.spans[0]?.description).toBe("navigation /connect");
  });

  test("the hooks cover breadcrumbs, errors and transactions, in the browser and on the server", () => {
    expect(sentryOptions.beforeBreadcrumb).toBe(scrubFragments);
    expect(sentryOptions.beforeSend).toBe(scrubFragments);
    expect(sentryOptions.beforeSendTransaction).toBe(scrubFragments);
  });
});
