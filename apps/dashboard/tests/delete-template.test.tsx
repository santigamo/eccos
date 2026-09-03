import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The consequence copy on the delete confirm
 * (`components/templates/delete-template-dialog.tsx`).
 *
 * The dialog itself is a Base UI alert dialog behind a portal, so there is no
 * static markup to assert — but its one load-bearing decision is pure and is
 * asserted here directly: WHICH sentence the operator is shown before a
 * template is removed.
 *
 * Importing the module pulls in `src/server/gateway.ts`, so the runtime shims
 * are installed through the shared helper BEFORE the dynamic import.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { deleteConfirmCopy } = await import(
  "../src/components/templates/delete-template-dialog"
);

describe("deleteConfirmCopy", () => {
  test("names the 30-day name lock only for an approved template", () => {
    // Meta documents the lock for APPROVED templates. Saying it on a pending
    // or rejected draft would be the console inventing a consequence; not
    // saying it on an approved one would let an operator burn a name for a
    // month without being told.
    expect(deleteConfirmCopy("APPROVED")).toContain("30 days");
    expect(deleteConfirmCopy("approved")).toContain("30 days");
  });

  test("says plainly what a non-approved deletion does, and hedges nothing", () => {
    for (const status of ["PENDING", "REJECTED", "PAUSED", undefined]) {
      const copy = deleteConfirmCopy(status);
      expect(copy, String(status)).toBe("This permanently removes the template.");
      expect(copy, String(status)).not.toContain("30 days");
      // No invented hedging: "may", "might", "could" are the console guessing
      // out loud about a rule it cannot source.
      expect(copy, String(status)).not.toMatch(/\bmay\b|\bmight\b|\bcould\b/);
    }
  });
});
