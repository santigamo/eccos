import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  authoringReading,
  canEditStatus,
  lastUpdated,
  qualityReading,
  rejectionReason,
  templateView,
  type TemplateRecord,
} from "../src/lib/template-view";
import { TemplateDetail } from "../src/components/templates/template-preview-sheet";
import { WhatsAppPreview } from "../src/components/templates/whatsapp-preview";

const simple: TemplateRecord = {
  id: "88",
  name: "order_update",
  language: "en_US",
  status: "APPROVED",
  category: "UTILITY",
  components: [
    { type: "BODY", text: "Hi {{1}}, order {{2}} shipped.", example: { body_text: [["Ada", "A-1029"]] } },
    { type: "FOOTER", text: "Powered by Eccos" },
    {
      type: "BUTTONS",
      buttons: [{ type: "URL", text: "Track", url: "https://e.cc/t/{{1}}", example: ["https://e.cc/t/A-1029"] }],
    },
  ],
};

const withImage: TemplateRecord = {
  ...simple,
  id: "99",
  components: [
    { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://cdn.test/a.jpg"] } },
    ...(simple.components as unknown[]),
  ],
};

describe("templateView", () => {
  test("reads header, body, footer, buttons and Meta's stored examples", () => {
    const view = templateView(withImage);
    expect(view?.header).toEqual({ format: "IMAGE", exampleUrl: "https://cdn.test/a.jpg" });
    expect(view?.body).toBe("Hi {{1}}, order {{2}} shipped.");
    expect(view?.footer).toBe("Powered by Eccos");
    expect(view?.bodyExamples).toEqual({ "1": "Ada", "2": "A-1029" });
    expect(view?.buttons).toEqual([
      { kind: "url", text: "Track", url: "https://e.cc/t/{{1}}", exampleUrl: "https://e.cc/t/A-1029" },
    ]);
  });

  test("a text header keeps its own examples; named examples are read by name", () => {
    const view = templateView({
      components: [
        { type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["A-1"] } },
        { type: "BODY", text: "Hi {{name}}", example: { body_text_named_params: [{ param_name: "name", example: "Ada" }] } },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }, { type: "PHONE_NUMBER", text: "Call", phone_number: "+34" }] },
      ],
    });
    expect(view?.header).toEqual({ format: "TEXT", text: "Order {{1}}" });
    expect(view?.headerExamples).toEqual({ "1": "A-1" });
    expect(view?.bodyExamples).toEqual({ name: "Ada" });
    expect(view?.buttons.map((button) => button.kind)).toEqual(["quick_reply", "phone"]);
  });

  test("no components means nothing to preview", () => {
    expect(templateView({})).toBeNull();
  });
});

describe("authoringReading", () => {
  test("a body, footer and link buttons become the form's draft", () => {
    const reading = authoringReading(simple);
    expect(reading).toEqual({
      ok: true,
      draft: {
        name: "order_update",
        language: "en_US",
        category: "UTILITY",
        body: "Hi {{1}}, order {{2}} shipped.",
        examples: ["Ada", "A-1029"],
        footer: "Powered by Eccos",
        buttons: [{ text: "Track", url: "https://e.cc/t/{{1}}", exampleUrl: "https://e.cc/t/A-1029" }],
      },
    });
  });

  test("anything the form cannot carry is refused with the reason, never dropped", () => {
    // Meta's edit replaces every component, so a part the form cannot hold
    // would be deleted by the save.
    expect(authoringReading(withImage)).toEqual({
      ok: false,
      reason: "It has an image header, which the console does not author yet.",
    });
    expect(
      authoringReading({ ...simple, components: [{ type: "BODY", text: "Hi" }, { type: "CAROUSEL", cards: [] }] }),
    ).toEqual({ ok: false, reason: "It has a carousel component, which the console does not author." });
    expect(authoringReading({ ...simple, components: [{ type: "BODY", text: "Hi {{name}}" }] }).ok).toBe(false);
    expect(authoringReading({ ...simple, category: "AUTHENTICATION" }).ok).toBe(false);
    expect(authoringReading({ ...simple, parameter_format: "NAMED" }).ok).toBe(false);
    expect(
      authoringReading({
        ...simple,
        components: [{ type: "BODY", text: "Hi" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] }],
      }).ok,
    ).toBe(false);
  });
});

describe("review facts", () => {
  test("rejection reason, quality, last update and edit window", () => {
    expect(rejectionReason({ rejected_reason: "TAG_CONTENT_MISMATCH" })).toBe("Content does not match the category");
    expect(rejectionReason({ rejected_reason: "NONE" })).toBeNull();
    expect(qualityReading({ quality_score: { score: "YELLOW" } })).toEqual({ label: "Medium", tone: "warning" });
    expect(qualityReading({})).toBeNull();
    expect(lastUpdated({ last_updated_time: "2026-10-21T09:14:31+0000" })?.toISOString()).toBe(
      "2026-10-21T09:14:31.000Z",
    );
    expect(lastUpdated({ last_updated_time: "nonsense" })).toBeNull();
    expect(canEditStatus("approved")).toBe(true);
    expect(canEditStatus("PENDING")).toBe(false);
  });
});

describe("TemplateDetail", () => {
  const render = (row: TemplateRecord, actions = {}) =>
    renderToStaticMarkup(<TemplateDetail row={row} wabaId="WABA_A" businessName="+34 600" actions={actions} />);

  test("shows the WhatsApp preview with Meta's examples, and the review facts", () => {
    const html = render({ ...simple, status: "REJECTED", rejected_reason: "INVALID_FORMAT" });
    expect(html).toContain('aria-label="Preview as the customer sees it in WhatsApp"');
    expect(html).toContain(">Ada<");
    expect(html).toContain("Rejected for");
    expect(html).toContain("Invalid format");
    expect(html).toContain("{{2}}");
    expect(html).toContain("A-1029");
    expect(html).toContain("https://e.cc/t/{{1}}");
  });

  test("offers only the acts it is given, and says why authoring is not one of them", () => {
    const html = render(withImage, {
      onSend: () => {},
      authoringBlocked: "It has an image header, which the console does not author yet.",
    });
    expect(html).toContain(">Send test<");
    expect(html).not.toContain(">Edit<");
    expect(html).toContain("It has an image header");
    expect(html).toContain("business.facebook.com/wa/manage/message-templates/?waba_id=WABA_A");
  });

  test("a row without components is a structured empty state", () => {
    expect(render({ id: "1", name: "x" })).toContain("No preview");
  });
});

describe("WhatsAppPreview", () => {
  test("past three buttons it shows two and 'See all options', as WhatsApp does", () => {
    const html = renderToStaticMarkup(
      <WhatsAppPreview
        businessName="Biz"
        header={null}
        body="Hi"
        buttons={[1, 2, 3, 4].map((n) => ({ kind: "quick_reply" as const, text: `Option ${n}` }))}
      />,
    );
    expect(html).toContain("Option 2");
    expect(html).not.toContain("Option 3");
    expect(html).toContain("See all options");
  });

  test("an unfilled placeholder shows as itself; a media header without an example is a placeholder", () => {
    const html = renderToStaticMarkup(
      <WhatsAppPreview businessName="Biz" header={{ format: "VIDEO", exampleUrl: null }} body="Hi {{1}}" />,
    );
    expect(html).toContain(">{{1}}<");
    expect(html).toContain("aspect-[1.91/1]");
    expect(html).not.toContain("<img");
  });
});

