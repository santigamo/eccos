import { describe, expect, it } from "bun:test";
import { fillTemplate } from "@eccos/core/template-copy";

const body = (text: string) => ({ type: "BODY", text });
const params = (type: string, values: Record<string, unknown>[]) => ({ type, parameters: values });
const text = (value: string, name?: string) => ({ type: "text", text: value, ...(name ? { parameter_name: name } : {}) });

describe("fillTemplate", () => {
  it("fills positional placeholders in order", () => {
    const copy = fillTemplate([body("Hi {{1}}, your order {{2}} is ready.")], [params("body", [text("Ada"), text("A-17")])]);
    expect(copy).toEqual({ body: "Hi Ada, your order A-17 is ready." });
  });

  it("fills named placeholders by parameter_name, whatever their order", () => {
    const copy = fillTemplate(
      [body("Order {{order_id}} for {{ customer }}")],
      [params("body", [text("Ada", "customer"), text("A-17", "order_id")])],
    );
    expect(copy?.body).toBe("Order A-17 for Ada");
  });

  it("keeps a placeholder the send did not fill", () => {
    expect(fillTemplate([body("Hi {{1}}, see you {{2}}")], [params("body", [text("Ada")])])?.body).toBe(
      "Hi Ada, see you {{2}}",
    );
    expect(fillTemplate([body("Hi {{name}}")], undefined)?.body).toBe("Hi {{name}}");
  });

  it("reads a currency or date_time parameter by its fallback value", () => {
    const copy = fillTemplate(
      [body("Total {{1}} on {{2}}")],
      [
        params("body", [
          { type: "currency", currency: { fallback_value: "€12.50", code: "EUR", amount_1000: 12500 } },
          { type: "date_time", date_time: { fallback_value: "May 1" } },
        ]),
      ],
    );
    expect(copy?.body).toBe("Total €12.50 on May 1");
  });

  it("fills a text header from its own parameters, and keeps the footer and button labels", () => {
    const copy = fillTemplate(
      [
        { type: "HEADER", format: "TEXT", text: "Hello {{1}}" },
        body("Your code is {{1}}"),
        { type: "FOOTER", text: "Reply STOP to opt out" },
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://example.com/{{1}}" }, { type: "QUICK_REPLY", text: "Stop" }] },
      ],
      [params("header", [text("Ada")]), params("body", [text("4821")]), { type: "button", sub_type: "url", index: "0", parameters: [text("A-17")] }],
    );
    expect(copy).toEqual({
      header: "Hello Ada",
      body: "Your code is 4821",
      footer: "Reply STOP to opt out",
      buttons: ["Track", "Stop"],
    });
  });

  it("leaves a media header out: it has no words", () => {
    const copy = fillTemplate([{ type: "HEADER", format: "IMAGE" }, body("See the photo")], []);
    expect(copy).toEqual({ body: "See the photo" });
  });

  it("is null without a body", () => {
    expect(fillTemplate([{ type: "FOOTER", text: "x" }], [])).toBeNull();
    expect(fillTemplate(null, [])).toBeNull();
  });
});
