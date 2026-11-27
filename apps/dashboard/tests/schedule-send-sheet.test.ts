import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The "Schedule a send" sheet's dismissal rule (`components/scheduled/schedule-send-sheet.tsx`).
 * Importing the component pulls in `src/server/gateway.ts`, mocked BEFORE the import.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { refusesClose } = await import("../src/components/scheduled/schedule-send-sheet");

describe("dismissing the schedule sheet", () => {
  test("typed input or a request in flight refuses Escape and the backdrop", () => {
    expect(refusesClose({ guarded: true, reason: "escape-key" })).toBe(true);
    expect(refusesClose({ guarded: true, reason: "outside-press" })).toBe(true);
    expect(refusesClose({ guarded: false, reason: "escape-key" })).toBe(false);
    expect(refusesClose({ guarded: false, reason: "outside-press" })).toBe(false);
  });

  test("the X is never refused, so leaving always stays possible", () => {
    expect(refusesClose({ guarded: true, reason: "close-press" })).toBe(false);
    expect(refusesClose({ guarded: false, reason: "close-press" })).toBe(false);
  });
});
