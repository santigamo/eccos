import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BroadcastReview } from "../src/components/broadcasts/broadcast-review";
import { RecipientTable } from "../src/components/broadcasts/recipient-table";
import type { ListTable } from "../src/lib/list-file";
import { checkList, type Mapping, slotsOf } from "../src/lib/recipient-list";

const slots = slotsOf({ format: "positional", body: [{ key: "1", example: "Ana" }], buttons: [], headerMedia: null });
const table: ListTable = {
  name: null,
  rows: [["+34 600 111 222", "Ana"], ["3.46E+10", "Marta"], ["34600111222", "Ana"], ["611 902 337", ""]],
  columns: 2,
};
const mapping: Mapping = { header: false, phone: 0, sources: { "body:1": { column: 1 } }, fallback: {}, country: "ES" };
const check = checkList(table, mapping, slots);

const review = (consent: boolean | null) =>
  renderToStaticMarkup(
    <BroadcastReview
      check={check}
      pacePerMinute={48}
      label="Friday pickups"
      templateName="order_ready"
      language="es"
      category="MARKETING"
      sender="+34 911 000 111"
      consent={consent}
      onConsent={() => {}}
      onDownload={() => {}}
    />,
  );

describe("BroadcastReview", () => {
  test("states the counts the console derived, with each caveat beside its fact", () => {
    const html = review(null);
    expect(html).toContain("of the 4 rows in your list");
    expect(html).toContain("1 duplicate · 1 invalid number · 1 missing value");
    expect(html).toContain("at 48 a minute");
    expect(html).toContain("Sent messages cannot be recalled");
    expect(html).toContain("Eccos charges nothing per message");
    expect(html).not.toContain("Meta caps how many people");
    expect(html).not.toContain("Consent");
  });

  test("a marketing template asks for consent", () => {
    expect(review(false)).toContain("Everyone on this list agreed to receive WhatsApp messages from us.");
  });
});

test("RecipientTable tags each skipped row with its reason, and offers the skipped rows", () => {
  const html = renderToStaticMarkup(
    <RecipientTable slots={slots} check={check} previewRow={1} onPreview={() => {}} onDownload={() => {}} />,
  );
  expect(html).toContain("In the preview");
  expect(html).toContain("invalid number");
  expect(html).toContain("same number as row 1");
  expect(html).toContain("missing value");
  expect(html).toContain("Download the 3 skipped rows (CSV)");
  expect(html).toContain("More than a fifth of this list will not be sent.");
});
