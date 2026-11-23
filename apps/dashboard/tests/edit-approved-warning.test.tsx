import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * Editing an APPROVED template sends it back to Meta's review, and it cannot be
 * sent while it is PENDING. The toast says so as the edit sheet opens; the notice
 * above the submit and the success notice say so where the operator submits.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { APPROVED_EDIT_NOTICE, CreateTemplateFields, EMPTY_DRAFT, editApprovedWarning } = await import(
  "../src/components/templates/create-template-sheet"
);
const { Toaster } = await import("../src/components/ui/sonner");

const noop = () => {};

function renderEdit(
  notice: Parameters<typeof CreateTemplateFields>[0]["notice"] = null,
  status = "APPROVED",
): string {
  const draft = { ...EMPTY_DRAFT, name: "order_update", body: "Hi there" };
  return renderToStaticMarkup(
    <CreateTemplateFields
      wabaId="WABA_A"
      mode={{ kind: "edit", initial: draft, templateId: "T1", status }}
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

  test("an approved template's edit states the review, the edit limits and the alternative before saving", () => {
    const html = renderEdit();
    expect(html).toContain("sends it back to Meta&#x27;s review");
    expect(html).toContain("up to 24 hours");
    expect(html).toContain("once every 24 hours and up to 10 times in 30 days");
    expect(html).toContain("duplicate it as a new template instead");
    expect(html.indexOf("sends it back to Meta")).toBeLessThan(html.indexOf("Submit changes for review"));
  });

  test("no approved notice for a rejected or paused template, nor once the edit is submitted", () => {
    const marker = "This template is approved.";
    expect(APPROVED_EDIT_NOTICE).toContain(marker);
    expect(renderEdit(null, "REJECTED")).not.toContain(marker);
    expect(renderEdit(null, "PAUSED")).not.toContain(marker);
    expect(renderEdit({ ok: true, edited: true })).not.toContain(marker);
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
