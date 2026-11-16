import { describe, expect, test } from "bun:test";
import { previewOf } from "../src/lib/conversations";
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
    expect(reading.values.map((value) => [value.slot, value.value])).toEqual([
      ["Header {{1}}", "A-17"],
      ["{{customer}}", "Ada"],
    ]);
  });

  test("a copy without a body is no copy", () => {
    expect(templateMessageOf(sent({ ...template, copy: { header: "x" } })).copy).toBeNull();
  });
});

describe("previewOf a template", () => {
  test("shows the filled body when there is one, else the template's name", () => {
    expect(previewOf({ type: "template", text: "Hola Ada", direction: "out", at: 1 })).toBe("You: Hola Ada");
    expect(previewOf({ type: "template", text: "template:order_update", direction: "out", at: 1 })).toBe(
      "You: Template: order_update",
    );
    expect(previewOf({ type: "template", text: null, direction: "out", at: 1 })).toBe("You: Template");
  });
});
