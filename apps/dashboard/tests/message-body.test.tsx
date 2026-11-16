import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBody } from "../src/components/conversations/message-body";
import type { ThreadEntry } from "../src/lib/conversations";
import type { MessageRecord } from "../src/server/gateway";

const WABA = "waba-a";

function entry(type: string, content: unknown): ThreadEntry {
  const message: MessageRecord = {
    id: `wamid.${type}`,
    waId: "15550100",
    direction: "in",
    origin: "live",
    type,
    text: null,
    content: JSON.stringify(content),
    at: 0,
    status: null,
    error: null,
    targetId: null,
    phoneNumberId: "phone-a",
  };
  return { message, text: null, edited: false, deleted: false, reactions: [], myReaction: null, quoted: null };
}

describe("MessageBody media", () => {
  test("an image opens in the viewer from a lazy-loaded picture", () => {
    const html = renderToStaticMarkup(
      <MessageBody entry={entry("image", { media: { id: "media-1" } })} wabaId={WABA} />,
    );
    expect(html).toContain('aria-label="Open image"');
    expect(html).toContain('src="/media/waba-a/media-1"');
    expect(html).toContain('loading="lazy"');
  });

  test("a sticker shows no viewer button", () => {
    const html = renderToStaticMarkup(
      <MessageBody entry={entry("sticker", { media: { id: "media-2" } })} wabaId={WABA} />,
    );
    expect(html).not.toContain("Open image");
    expect(html).toContain('alt="Sticker"');
  });

  test("an image with no media id shows the unavailable fallback", () => {
    const html = renderToStaticMarkup(<MessageBody entry={entry("image", {})} wabaId={WABA} />);
    expect(html).toContain("Media not available");
    expect(html).not.toContain("Open image");
  });
});

describe("MessageBody template", () => {
  const sent = {
    name: "order_update",
    language: { code: "es" },
    components: [{ type: "body", parameters: [{ type: "text", text: "Ada" }] }],
  };

  test("with its copy, shows what the customer read, marked as a template by name", () => {
    const copy = { header: "Pedido", body: "Hola Ada, tu pedido está listo.", footer: "Eccos test", buttons: ["Gracias"] };
    const html = renderToStaticMarkup(<MessageBody entry={entry("template", { ...sent, copy })} wabaId={WABA} />);
    for (const words of ["Template", "order_update", "Pedido", "Hola Ada, tu pedido está listo.", "Eccos test", "Gracias"]) {
      expect(html).toContain(words);
    }
    expect(html).not.toContain("{{1}}");
  });

  test("without a copy, names the template and lists the values sent by slot", () => {
    const html = renderToStaticMarkup(<MessageBody entry={entry("template", sent)} wabaId={WABA} />);
    expect(html).toContain("order_update");
    expect(html).toContain("{{1}}");
    expect(html).toContain("Ada");
    expect(html).not.toContain("template:order_update");
  });

  test("a send that filled no parameters says so", () => {
    const html = renderToStaticMarkup(
      <MessageBody entry={entry("template", { name: "hello_world", language: { code: "en_US" } })} wabaId={WABA} />,
    );
    expect(html).toContain("hello_world");
    expect(html).toContain("This send filled no parameters.");
  });
});
