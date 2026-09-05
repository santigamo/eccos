import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rendering contract for the "Send test" sheet's form
 * (`components/templates/send-test-sheet.tsx`).
 *
 * The INNER FORM is what is rendered here, never `SendTestSheet` itself: the
 * sheet is a Base UI dialog and a closed dialog renders nothing at all, so a
 * static-markup assertion against it would pass against an empty string.
 * (Verified: `SendTestSheet` with `open` false produces "".)
 *
 * Importing the component pulls in `src/server/gateway.ts`, which imports
 * `cloudflare:workers` and `@tanstack/react-start` — mocked here BEFORE the
 * import, the same recipe as `tests/numbers-screen.test.tsx`.
 *
 * Design contract assertions (docs/DASHBOARD-DESIGN.md): square corners, the
 * Inter-uppercase-11px functional register on labels, and the live region.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { SendTestForm, SendTestSheet } = await import(
  "../src/components/templates/send-test-sheet"
);
const { analyzeTemplate } = await import("../src/lib/template-params");

const PHONES = [{ phoneNumberId: "PNID1", displayPhoneNumber: "+34600000000" }];

function render(
  sendability: ReturnType<typeof analyzeTemplate>,
  phones = PHONES,
): string {
  return renderToStaticMarkup(
    <SendTestForm
      wabaId="waba-a"
      templateName="hello_world"
      languageCode="en_US"
      sendability={sendability}
      phones={phones}
    />,
  );
}

const ready = (body: string) => analyzeTemplate({ components: [{ type: "BODY", text: body }] });

describe("SendTestForm", () => {
  test("a closed Sheet renders nothing, which is why these tests render the form", () => {
    // Pins the reason this file exists. If Base UI ever starts emitting the
    // popup's markup while closed, the assertions below could move up a level.
    expect(
      renderToStaticMarkup(
        <SendTestSheet
          open={false}
          onOpenChange={() => {}}
          wabaId="waba-a"
          templateName="hello_world"
          languageCode="en_US"
          status="APPROVED"
          sendability={ready("hi")}
          phones={PHONES}
        />,
      ),
    ).toBe("");
  });

  test("renders one input per positional parameter, and none for a bare template", () => {
    const two = render(ready("Hi {{1}}, your order {{2}} shipped."));
    expect(two).toContain('id="send-test-param-1"');
    expect(two).toContain('id="send-test-param-2"');
    expect(two).not.toContain('id="send-test-param-3"');

    const zero = render(ready("Welcome and congratulations!"));
    expect(zero).not.toContain("send-test-param-");
  });

  test("an unsupported template gets the reason and NO send button", () => {
    // Data rule 5: no dead buttons. The row still opens the sheet, because
    // "why can I not send this one?" is the operator's actual question — but
    // what they get is the answer, not a control that fails at Meta.
    const html = render(
      analyzeTemplate({ components: [{ type: "HEADER", format: "IMAGE" }] }),
    );
    expect(html).toContain("uploaded asset");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Send test message");
  });

  test("states the test-number allowlist rule where the recipient is typed", () => {
    // The single most likely failure during App Review filming. Saying it
    // before the send is cheaper than mapping the error after it.
    const html = render(ready("hi"));
    expect(html).toContain(
      "With a Cloud API test number, only recipients on its allowed list can receive messages.",
    );
  });

  test("shows the substituted body, so the sheet actually verifies rendering", () => {
    const html = render(ready("Hi {{1}}, your order shipped."));
    expect(html).toContain("Preview");
    // Nothing typed yet: the slot keeps its placeholder rather than vanishing.
    expect(html).toContain("{{1}}");
  });

  test("one phone reads as a static line; several become a select", () => {
    const single = render(ready("hi"));
    expect(single).toContain("+34600000000");
    expect(single).not.toContain('id="send-test-from"');

    const many = render(ready("hi"), [
      ...PHONES,
      { phoneNumberId: "PNID2", displayPhoneNumber: "+34600000001" },
    ]);
    expect(many).toContain('id="send-test-from"');
  });

  test("the live region is mounted before it has anything to say", () => {
    // A live region that appears WITH its message is not reliably announced;
    // one that fills up is. Same pattern as NumbersTable.
    const html = render(ready("hi"));
    expect(html).toMatch(/<output[^>]*aria-live="polite"/);
    expect(html).toMatch(/<output[^>]*aria-atomic="true"/);
  });

  test("dynamic URL buttons render as one input per slot, URL prefix as hint", () => {
    // §5.1: a template with a dynamic URL button gains a labelled "Button
    // links" group — a positional group of its own, like the body's — with one
    // input per dynamic button, the URL up to the {{n}} as the placeholder.
    const html = render(
      analyzeTemplate({
        components: [
          { type: "BODY", text: "Hi {{1}}" },
          {
            type: "BUTTONS",
            buttons: [{ type: "URL", text: "Status", url: "https://e.com/s?t={{1}}" }],
          },
        ],
      }),
    );
    expect(html).toContain("Button links");
    expect(html).toContain('id="send-test-button-0"');
    expect(html).toContain("https://e.com/s?t=");
    expect(html).toContain("Send test message");
  });

  test("a template with no dynamic URL buttons has no button group", () => {
    const html = render(ready("Welcome and congratulations!"));
    expect(html).not.toContain("Button links");
    expect(html).not.toContain("send-test-button-");
  });

  test("labels wear the functional register (Inter uppercase 11px, tracking-wider)", () => {
    const html = render(ready("Hi {{1}}"));
    expect(html).toContain("text-[11px]");
    expect(html).toContain("tracking-wider");
    expect(html).toContain("uppercase");
  });

  test("nothing rounds a corner", () => {
    const html = render(ready("Hi {{1}}"), [
      ...PHONES,
      { phoneNumberId: "PNID2", displayPhoneNumber: "+34600000001" },
    ]);
    const stripped = html
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
  });

  test("interactive controls keep the ghost anatomy and the green hover edge", () => {
    // The console's own law: a ghost control rests on --ghost-fill under a
    // --line-strong edge and turns green under the pointer. A sheet that lost
    // the green edge has regressed even if it looks cleaner.
    const html = render(ready("hi"), [
      ...PHONES,
      { phoneNumberId: "PNID2", displayPhoneNumber: "+34600000001" },
    ]);
    expect(html).toContain("bg-(--ghost-fill)");
    expect(html).toContain("border-(--line-strong)");
    expect(html).toContain("hover:border-(--ghost-edge-hover)");
  });
});
