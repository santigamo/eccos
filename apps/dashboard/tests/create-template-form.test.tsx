import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rendering contract for the "New template" sheet's form
 * (`components/templates/create-template-sheet.tsx`).
 *
 * `CreateTemplateFields` is what is rendered here, never `CreateTemplateSheet`:
 * the sheet is a Base UI dialog and a closed dialog renders nothing at all, so
 * a static-markup assertion against it would pass against an empty string. The
 * fields are fully controlled — the same split as `WorkspaceFormFields` — which
 * is what lets every state (blocked draft, warnings, a success notice) be
 * rendered without driving a browser.
 *
 * Importing the component pulls in `src/server/gateway.ts`, which imports
 * `cloudflare:workers` and `@tanstack/react-start` — mocked here BEFORE the
 * import through the shared helper, whose header explains why it must be shared.
 *
 * Design contract assertions (docs/DASHBOARD-DESIGN.md): square corners, the
 * Inter-uppercase-11px functional register on labels, the ghost anatomy with
 * its green hover edge, and the live region.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const {
  CreateTemplateFields,
  CreateTemplateSheet,
  EMPTY_DRAFT,
  exampleValues,
  noticeFor,
} = await import("../src/components/templates/create-template-sheet");

type Draft = typeof EMPTY_DRAFT;
type Notice = ReturnType<typeof noticeFor>;

const noop = () => {};

/**
 * Is the SUBMIT button disabled?
 *
 * Read off the button's own attributes, never with a loose /disabled/ match:
 * every control in this form carries `disabled:*` Tailwind variants in its
 * class string, so a substring test passes on markup where nothing is disabled
 * at all.
 */
function submitDisabled(html: string): boolean {
  const start = html.indexOf('<button type="submit"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(">", start)).includes('disabled=""');
}

function render(draft: Partial<Draft> = {}, notice: Notice | null = null): string {
  return renderToStaticMarkup(
    <CreateTemplateFields
      wabaId="WABA_A"
      draft={{ ...EMPTY_DRAFT, ...draft }}
      onDraftChange={noop}
      submitting={false}
      notice={notice}
      onSubmit={noop}
    />,
  );
}

describe("CreateTemplateFields", () => {
  test("a closed Sheet renders nothing, which is why these tests render the fields", () => {
    // Pins the reason this file exists, the same way send-test-form.test.tsx
    // does. If Base UI ever starts emitting the popup's markup while closed,
    // the assertions below could move up a level.
    expect(
      renderToStaticMarkup(
        <CreateTemplateSheet open={false} onOpenChange={noop} wabaId="WABA_A" />,
      ),
    ).toBe("");
  });

  test("one example input per variable, derived from the body", () => {
    // The inputs and the placeholders are one thing, not two that must be kept
    // in sync: the count comes from `analyzeDraftBody` on every render.
    const two = render({ body: "Hi {{1}}, order {{2}} shipped." });
    expect(two).toContain('id="create-template-example-1"');
    expect(two).toContain('id="create-template-example-2"');
    expect(two).not.toContain('id="create-template-example-3"');

    const zero = render({ body: "Welcome and congratulations!" });
    expect(zero).not.toContain("create-template-example-");
  });

  test("shrinking the body keeps the values typed for the variables that remain", () => {
    // The backing array is only ever grown, so removing {{2}} and typing it
    // back does not cost the operator what they already wrote.
    const draft = { body: "Hi {{1}}", examples: ["Ada", "A-1029"] };
    expect(exampleValues({ ...EMPTY_DRAFT, ...draft })).toEqual(["Ada"]);
    expect(exampleValues({ ...EMPTY_DRAFT, body: "Hi {{1}} {{2}}", examples: ["Ada", "A-1029"] })).toEqual([
      "Ada",
      "A-1029",
    ]);
    const html = render(draft);
    expect(html).toContain('value="Ada"');
    expect(html).not.toContain("A-1029");
  });

  test("the preview substitutes typed examples and keeps an unfilled slot literal", () => {
    // The preview never pretends a value exists — the same rule the send
    // sheet's preview follows, from the same `previewBody`.
    const html = render({ body: "Hi {{1}}, order {{2}} shipped.", examples: ["Ada"] });
    expect(html).toContain("Preview");
    expect(html).toContain("Hi Ada, order {{2}} shipped.");
  });

  test("the preview names the row that is about to exist", () => {
    // name · language · CATEGORY, in the machine voice: what the table will
    // show, before it shows it.
    const html = render({ name: "order_update", body: "Hi", category: "MARKETING" });
    expect(html).toMatch(/order_update[^<]*·[^<]*en_US[^<]*·[^<]*MARKETING/);
  });

  test("a blocked draft disables submit AND shows the reason", () => {
    // No dead buttons and no silent walls: a disabled control is only honest
    // while the sentence explaining it is on screen next to the field.
    const html = render({ body: "Hi {{customer_name}}" });
    expect(html).toContain("Named parameters cannot be created here");
    expect(submitDisabled(html)).toBe(true);
    expect(html).toContain('aria-invalid="true"');
  });

  test("an acceptable draft leaves submit live", () => {
    const html = render({ body: "Hi {{1}}, your order is on its way and arrives tomorrow." });
    expect(submitDisabled(html)).toBe(false);
  });

  test("review warnings render amber and never disable anything", () => {
    // Reseller-sourced heuristics warn; only Meta's own rules wall.
    const html = render({ body: "{{1}} {{2}} {{3}}" });
    expect(html).toContain("#f0a020");
    expect(html).toContain("start or end with a variable");
    expect(submitDisabled(html)).toBe(false);
  });

  test("the success notice reports PENDING and the id Meta returned", () => {
    const notice = noticeFor({ ok: true, id: "1234567890", status: "PENDING", category: "UTILITY" }, "UTILITY");
    const html = render({ name: "order_update" }, notice);
    expect(html).toContain("Submitted for review");
    expect(html).toContain("PENDING");
    expect(html).toContain("1234567890");
    expect(html).not.toContain("categorized this template");
  });

  test("recategorisation is reported only when Meta's answer differs from the request", () => {
    // The console reports META'S ANSWER, not the operator's request: Meta
    // recategorises on its own and the row will show its category, not ours.
    const moved = noticeFor(
      { ok: true, id: "1", status: "PENDING", category: "MARKETING" },
      "UTILITY",
    );
    expect(render({}, moved)).toContain("Meta categorized this template as MARKETING.");
  });

  test("a refusal renders the console's copy, with Meta's sentence only as a secondary line", () => {
    const taken = noticeFor({ ok: false, code: "name_taken", detail: "raw graph text" }, "UTILITY");
    const html = render({}, taken);
    expect(html).toContain("Name already in use");
    // Graph's own wording explains, it never discriminates — and for a code the
    // console fully explains itself, it is not shown at all.
    expect(html).not.toContain("raw graph text");

    const unmapped = noticeFor({ ok: false, code: "graph", detail: "raw graph text" }, "UTILITY");
    expect(render({}, unmapped)).toContain("raw graph text");
  });

  test("renders the footer field and the button add/remove group", () => {
    const html = render();
    expect(html).toContain("Footer");
    expect(html).toContain('id="create-template-footer"');
    expect(html).toContain("Add button");
    expect(html).toContain("Buttons");
  });

  test("a dynamic URL reveals its example field; a static one does not", () => {
    // Dynamic = the URL carries a {{n}}: that is exactly when Meta requires the
    // example URL, so the field exists only then.
    const dynamic = render({
      body: "hi",
      buttons: [{ text: "Status", url: "https://e.com/s?t={{1}}", exampleUrl: "" }],
    });
    expect(dynamic).toContain("Example URL");
    const staticOne = render({
      body: "hi",
      buttons: [{ text: "Track", url: "https://e.com/track", exampleUrl: "" }],
    });
    expect(staticOne).not.toContain("Example URL");
  });

  test("a blocked footer or button disables submit and says why", () => {
    const footer = render({ body: "hi", footer: "Hi {{1}}!" });
    expect(footer).toContain("cannot contain variables");
    expect(submitDisabled(footer)).toBe(true);

    const buttons = render({
      body: "hi",
      buttons: [{ text: "x", url: "ftp://e.com", exampleUrl: "" }],
    });
    expect(buttons).toContain("https");
    // A button whose URL is not https is blocked; the same draft with a valid
    // URL and a filled dynamic example submits.
    expect(submitDisabled(buttons)).toBe(true);
    const ok = render({
      body: "hi",
      buttons: [{ text: "Status", url: "https://e.com/s?t={{1}}", exampleUrl: "https://e.com/s?t=T" }],
    });
    expect(submitDisabled(ok)).toBe(false);
    // Four buttons is impossible to author (the add control caps at three).
    const four = render({
      body: "hi",
      buttons: [
        { text: "a", url: "https://e.com/1", exampleUrl: "" },
        { text: "b", url: "https://e.com/2", exampleUrl: "" },
        { text: "c", url: "https://e.com/3", exampleUrl: "" },
        { text: "d", url: "https://e.com/4", exampleUrl: "" },
      ],
    });
    expect(four).toContain("at most 3");
    expect(submitDisabled(four)).toBe(true);
  });

  test("states the scope wall once, with the way out", () => {
    // The same honesty pattern as the send sheet's `unsupported` copy: what the
    // console does NOT do, said plainly, with the tool that does.
    const html = render();
    expect(html).toContain("The console creates text templates");
    expect(html).toContain("WhatsApp Manager");
    expect(html).toContain("waba_id=WABA_A");
  });

  test("the live region is mounted before it has anything to say", () => {
    const html = render();
    expect(html).toMatch(/<output[^>]*aria-live="polite"/);
    expect(html).toMatch(/<output[^>]*aria-atomic="true"/);
  });

  test("labels wear the functional register (Inter uppercase 11px, tracking-wider)", () => {
    const html = render({ body: "Hi {{1}}" });
    expect(html).toContain("text-[11px]");
    expect(html).toContain("tracking-wider");
    expect(html).toContain("uppercase");
  });

  test("nothing rounds a corner", () => {
    const html = render({ body: "Hi {{1}}" });
    const stripped = html
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
  });

  test("interactive controls keep the ghost anatomy and the green hover edge", () => {
    // The console's own law: a ghost control rests on --ghost-fill under a
    // --line-strong edge and turns green under the pointer.
    const html = render({ body: "Hi {{1}}" });
    expect(html).toContain("bg-(--ghost-fill)");
    expect(html).toContain("border-(--line-strong)");
    expect(html).toContain("hover:border-(--ghost-edge-hover)");
  });

  test("the preview panel stays square and muted, exactly like the send sheet's", () => {
    // Deliberate: a rounded WhatsApp-style bubble here would break sheet-to-
    // sheet consistency before it broke the design doc. What must not lie is
    // the content; the container is chrome.
    const html = render({ body: "Hi {{1}}" });
    expect(html).toContain("border border-(--line) bg-muted p-3 text-sm whitespace-pre-wrap");
  });
});
