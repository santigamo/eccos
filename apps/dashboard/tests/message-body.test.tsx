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
