import { describe, expect, test } from "bun:test";
import { parseWhatsApp } from "../src/lib/whatsapp-format";

describe("parseWhatsApp", () => {
  test("reads the four markers and keeps placeholders as their own nodes", () => {
    expect(parseWhatsApp("*Hi* _there_ ~old~ `code` {{1}}")).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "Hi" }] },
      { kind: "text", text: " " },
      { kind: "italic", children: [{ kind: "text", text: "there" }] },
      { kind: "text", text: " " },
      { kind: "strike", children: [{ kind: "text", text: "old" }] },
      { kind: "text", text: " " },
      { kind: "mono", children: [{ kind: "text", text: "code" }] },
      { kind: "text", text: " " },
      { kind: "var", key: "1" },
    ]);
  });

  test("a placeholder inside bold stays a placeholder", () => {
    expect(parseWhatsApp("¡Hola *{{1}}*!")).toEqual([
      { kind: "text", text: "¡Hola " },
      { kind: "bold", children: [{ kind: "var", key: "1" }] },
      { kind: "text", text: "!" },
    ]);
  });

  test("markers inside a word, or with a space just inside, stay text", () => {
    expect(parseWhatsApp("order_update_v2")).toEqual([{ kind: "text", text: "order_update_v2" }]);
    expect(parseWhatsApp("2*3*4")).toEqual([{ kind: "text", text: "2*3*4" }]);
    expect(parseWhatsApp("a * b *")).toEqual([{ kind: "text", text: "a * b *" }]);
  });

  test("an inline marker never spans lines; a triple-backtick block does", () => {
    expect(parseWhatsApp("*one\ntwo*")).toEqual([{ kind: "text", text: "*one\ntwo*" }]);
    expect(parseWhatsApp("```a\nb```")).toEqual([{ kind: "mono", children: [{ kind: "text", text: "a\nb" }] }]);
  });

  test("named placeholders are kept by name", () => {
    expect(parseWhatsApp("Hi {{first_name}}")).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "var", key: "first_name" },
    ]);
  });

  test("an emoji next to a marker is a boundary, as on the phone", () => {
    expect(parseWhatsApp("🎉*Sale*🎉")).toEqual([
      { kind: "text", text: "🎉" },
      { kind: "bold", children: [{ kind: "text", text: "Sale" }] },
      { kind: "text", text: "🎉" },
    ]);
  });

  test("placeholders inside code are still placeholders", () => {
    expect(parseWhatsApp("Code: `{{1}}`")).toEqual([
      { kind: "text", text: "Code: " },
      { kind: "mono", children: [{ kind: "var", key: "1" }] },
    ]);
    expect(parseWhatsApp("```{{1}}```")).toEqual([{ kind: "mono", children: [{ kind: "var", key: "1" }] }]);
  });
});
