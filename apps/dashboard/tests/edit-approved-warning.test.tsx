import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * One language's panel on the authoring page
 * (`components/templates/language-panel.tsx`): editing an APPROVED language
 * sends it back to Meta's review, so the panel says so in an amber callout once
 * it is edited; a PENDING one is read-only; a REJECTED one says why.
 */

const { LanguagePanel } = await import("../src/components/templates/language-panel");
const { APPROVED_EDIT_NOTICE } = await import("../src/lib/template-draft");
const { buildTabs } = await import("../src/lib/template-group");
const { Toaster } = await import("../src/components/ui/sonner");

const noop = () => {};

function row(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "T1",
    name: "order_update",
    language: "en_US",
    status,
    category: "UTILITY",
    components: [{ type: "BODY", text: "Hi there" }],
    ...extra,
  };
}

function render(status: string, body?: string, extra: Record<string, unknown> = {}): string {
  const drafts = body ? { en_US: { language: "en_US", body, examples: [], footer: "", buttons: [] } } : {};
  const [tab] = buildTabs({ rows: [row(status, extra)], drafts, added: [], submitted: {}, errors: {}, category: "UTILITY" });
  return renderToStaticMarkup(
    <LanguagePanel
      tab={tab!}
      wabaId="WABA_A"
      takenLanguages={[]}
      canRemove={false}
      onChange={noop}
      onLanguageChange={noop}
      onRemove={noop}
      onDelete={noop}
    />,
  );
}

describe("an approved language", () => {
  test("says nothing until it is edited", () => {
    expect(render("APPROVED")).not.toContain("This template is approved.");
  });

  test("once edited, states the review, the edit limits and the alternative", () => {
    const html = render("APPROVED", "Hi there!");
    expect(APPROVED_EDIT_NOTICE).toContain("This template is approved.");
    expect(html).toContain("sends it back to Meta&#x27;s review");
    expect(html).toContain("up to 24 hours");
    expect(html).toContain("once every 24 hours and up to 10 times in 30 days");
    expect(html).toContain("duplicate it as a new template instead");
    expect(html).toContain("border-l-warning");
  });

  test("shows the real status tag and the actions menu", () => {
    const html = render("APPROVED");
    expect(html).toContain(">APPROVED<");
    expect(html).toContain('aria-label="Actions for English (US)"');
  });
});

describe("a language in review", () => {
  test("is read-only: one support line, no inputs", () => {
    const html = render("PENDING");
    expect(html).toContain("Meta is reviewing English (US), usually for a few minutes. It can be edited again once Meta answers.");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Hi there");
  });
});

describe("a rejected language", () => {
  test("says why in a red callout and stays editable", () => {
    const html = render("REJECTED", undefined, { rejected_reason: "PROMOTIONAL" });
    expect(html).toContain("Meta rejected English (US): Promotional content.");
    expect(html).toContain("border-l-destructive");
    expect(html).toContain("<textarea");
  });
});

describe("Toaster", () => {
  test("server-renders an empty live region, so a toast raised on navigation is still announced", () => {
    const html = renderToStaticMarkup(<Toaster />);
    expect(html).toContain('aria-label="Notifications');
    expect(html).toContain('aria-live="polite"');
  });
});
