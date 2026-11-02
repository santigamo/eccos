import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * Editing an APPROVED template sends it back to Meta's review, and it cannot be
 * sent while it is PENDING. The toast says so as the edit sheet opens; the note
 * under the submit and the success notice say so where the operator submits.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { CreateTemplateFields, EMPTY_DRAFT, editApprovedWarning } = await import(
  "../src/components/templates/create-template-sheet"
);
const { Toaster } = await import("../src/components/ui/sonner");

const noop = () => {};

function renderEdit(notice: Parameters<typeof CreateTemplateFields>[0]["notice"] = null): string {
  const draft = { ...EMPTY_DRAFT, name: "order_update", body: "Hi there" };
  return renderToStaticMarkup(
    <CreateTemplateFields
      wabaId="WABA_A"
      mode={{ kind: "edit", initial: draft, templateId: "T1", status: "APPROVED" }}
      draft={draft}
      onDraftChange={noop}
      submitting={false}
      notice={notice}
      onSubmit={noop}
    />,
  );
}

describe("editApprovedWarning", () => {
  test("warns for an approved template, in any case", () => {
    const warning = editApprovedWarning("APPROVED");
    expect(warning).toBe(
      "Editing an approved template sends it back to review. Until Meta approves it again it shows as Pending and can't be sent.",
    );
    expect(editApprovedWarning("approved")).toBe(warning);
  });

  test("stays quiet for statuses that were not sendable before the edit", () => {
    for (const status of ["REJECTED", "PAUSED", "PENDING", undefined]) {
      expect(editApprovedWarning(status)).toBeNull();
    }
  });
});

describe("where the operator submits", () => {
  test("the note under the submit says a pending template cannot be sent", () => {
    expect(renderEdit()).toContain("be sent until it is approved");
  });

  test("the success notice says the template is pending and cannot be sent", () => {
    expect(renderEdit({ ok: true, edited: true })).toContain(
      "The template is pending review and can&#x27;t be sent until Meta approves it.",
    );
  });
});

describe("Toaster", () => {
  test("server-renders an empty live region, so a toast raised under an open sheet is still announced", () => {
    const html = renderToStaticMarkup(<Toaster />);
    expect(html).toContain('aria-label="Notifications');
    expect(html).toContain('aria-live="polite"');
  });
});
