import { describe, expect, test } from "bun:test";
import { describeEntry, previewOf } from "../src/lib/conversations";
import { templateMessageOf } from "../src/lib/template-message";
import type { MessageRecord } from "../src/server/gateway";

function sent(content: unknown): MessageRecord {
  return {
    id: "wamid.T",
    waId: "15550100",
    direction: "out",
    origin: "live",
    type: "template",
    text: null,
    content: JSON.stringify(content),
    at: 0,
    status: "sent",
    error: null,
    targetId: null,
    phoneNumberId: "phone-a",
  };
}

const template = {
  name: "order_update",
  language: { code: "es" },
  components: [
    { type: "header", parameters: [{ type: "text", text: "A-17" }] },
    { type: "body", parameters: [{ type: "text", text: "Ada", parameter_name: "customer" }] },
  ],
};

describe("templateMessageOf", () => {
  test("reads the stored copy, keeping only well-formed parts", () => {
    const reading = templateMessageOf(sent({ ...template, copy: { body: "Hola Ada", footer: 3, buttons: ["Ok", 1] } }));
    expect(reading.name).toBe("order_update");
    expect(reading.copy).toEqual({ body: "Hola Ada", buttons: ["Ok"] });
  });

  test("without a copy, keeps the values sent by slot", () => {
    const reading = templateMessageOf(sent(template));
    expect(reading.copy).toBeNull();
    expect(reading.filledNone).toBe(false);
    expect(reading.values.map((value) => [value.slot, value.value])).toEqual([
      ["Header {{1}}", "A-17"],
      ["{{customer}}", "Ada"],
    ]);
  });

  test("only a named template with no parameters filled none", () => {
    expect(templateMessageOf(sent({ name: "hello_world", language: { code: "en_US" } })).filledNone).toBe(true);
    expect(templateMessageOf(sent({})).filledNone).toBe(false);
  });

  test("a copy without a body is no copy", () => {
    expect(templateMessageOf(sent({ ...template, copy: { header: "x" } })).copy).toBeNull();
  });
});

describe("a template's preview", () => {
  test("the list shows the filled body the gateway reads from the copy, else the Template label", () => {
    expect(previewOf({ type: "template", text: "Hola Ada", direction: "out", at: 1 })).toBe("You: Hola Ada");
    expect(previewOf({ type: "template", text: null, direction: "out", at: 1 })).toBe("You: Template");
  });

  test("a quote reads the copy, else the name, never the stored marker", () => {
    const quote = (content: unknown) =>
      describeEntry({ message: { ...sent(content), text: "template:order_update" }, text: "template:order_update", deleted: false }).preview;
    expect(quote({ ...template, copy: { body: "Hola Ada" } })).toBe("Hola Ada");
    expect(quote(template)).toBe("Template: order_update");
    expect(quote({})).toBe("Template");
  });
});
