import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rendering contract for the template preview
 * (`components/templates/template-preview-sheet.tsx`, bead eccos-6je,
 * docs/console-gaps-2026-09 §4).
 *
 * `TemplatePreview` is what is rendered here, never `TemplatePreviewSheet`:
 * the sheet is a Base UI dialog and a closed dialog renders nothing at all, so
 * a static-markup assertion against it would pass against an empty string —
 * the same split as `SendTestForm` / `CreateTemplateFields`.
 *
 * Importing the component pulls in `src/server/gateway.ts`, which imports
 * `cloudflare:workers` and `@tanstack/react-start` — mocked here BEFORE the
 * import through the shared helper (whose header explains why it must be
 * shared).
 *
 * Design contract assertions (docs/DASHBOARD-DESIGN.md): square corners, the
 * Inter-uppercase-11px functional register on labels, muted ink, and the
 * nothing-rounds-a-corner law.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { TemplatePreview, TemplatePreviewSheet } = await import(
  "../src/components/templates/template-preview-sheet"
);

function render(components: unknown): string {
  return renderToStaticMarkup(<TemplatePreview components={components} />);
}

const FULL_TEMPLATE = [
  { type: "HEADER", format: "TEXT", text: "Your booking" },
  { type: "BODY", text: "Hi {{1}}, your order {{2}} shipped." },
  { type: "FOOTER", text: "Powered by Eccos" },
  {
    type: "BUTTONS",
    buttons: [
      { type: "URL", text: "Track order", url: "https://e.com/status" },
      { type: "URL", text: "Reschedule", url: "https://e.com/reschedule?t={{1}}" },
    ],
  },
];

describe("TemplatePreview", () => {
  test("a closed Sheet renders nothing, which is why these tests render the preview", () => {
    // Pins the reason this file renders `TemplatePreview` directly, the same
    // way send-test-form.test.tsx pins its own split. If Base UI ever starts
    // emitting the popup's markup while closed, the assertions could move up a
    // level.
    expect(
      renderToStaticMarkup(
        <TemplatePreviewSheet
          open={false}
          onOpenChange={() => {}}
          templateName="order_update"
          language="en_US"
          components={FULL_TEMPLATE}
        />,
      ),
    ).toBe("");
  });

  test("body keeps its {{n}} placeholders visible, never pretending a value exists", () => {
    // The preview is READ-ONLY — nothing is filled in, so an unfilled slot
    // stays the literal `{{n}}` Meta authored. Same rule and same `previewBody`
    // as the send sheet's preview, applied with no values.
    const html = render(FULL_TEMPLATE);
    expect(html).toContain("Body");
    expect(html).toContain("Hi {{1}}, your order {{2}} shipped.");
  });

  test("renders the header and the footer as static text", () => {
    const html = render(FULL_TEMPLATE);
    expect(html).toContain("Header");
    expect(html).toContain("Your booking");
    expect(html).toContain("Footer");
    expect(html).toContain("Powered by Eccos");
  });

  test("renders every URL button with its label and its URL", () => {
    const html = render(FULL_TEMPLATE);
    expect(html).toContain("Buttons");
    expect(html).toContain("Track order");
    expect(html).toContain("https://e.com/status");
  });

  test("a dynamic URL button keeps its {{n}} visible, same convention as the body", () => {
    const html = render(FULL_TEMPLATE);
    expect(html).toContain("Reschedule");
    expect(html).toContain("https://e.com/reschedule?t={{1}}");
  });

  test("a template with no components renders a graceful empty state, not a crash", () => {
    // Data rule 6: a structured empty state, never a lone muted line. The sheet
    // still opens — "what does this look like?" is the operator's question — but
    // the honest answer is that there is nothing to show.
    const html = render(undefined);
    expect(html).toContain("No preview");
    expect(html).toContain("without a components array");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Body");
  });

  test("an empty components array reads as the same empty state", () => {
    const html = render([]);
    expect(html).toContain("No preview");
    expect(html).not.toContain("Body");
  });

  test("a body-only template renders the body and no empty header/footer/buttons", () => {
    const html = render([{ type: "BODY", text: "Welcome and congratulations!" }]);
    expect(html).toContain("Welcome and congratulations!");
    expect(html).not.toContain("Header");
    expect(html).not.toContain("Footer");
    expect(html).not.toContain("Buttons");
  });

  test("labels wear the functional register (Inter uppercase 11px, tracking-wider)", () => {
    const html = render(FULL_TEMPLATE);
    expect(html).toContain("text-[11px]");
    expect(html).toContain("tracking-wider");
    expect(html).toContain("uppercase");
  });

  test("nothing rounds a corner", () => {
    const html = render(FULL_TEMPLATE);
    const stripped = html
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
  });

  test("ink is muted and token-based — never a literal color hex", () => {
    // The preview is quiet: it is reference, not a control. Muted ink via the
    // `--muted-foreground` token, and not one literal hex color in the markup
    // (docs/DASHBOARD-DESIGN.md: "a hardcoded color in a component rule is
    // off-system").
    const html = render(FULL_TEMPLATE);
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});