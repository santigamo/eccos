import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { fences } from "./docs-md";

// README.md summarises `WhatsAppCallbackEvent` by hand. This test reads the
// union from types.ts with the compiler and fails when the summary names a
// different set of fields, so the README cannot fall behind the contract.

const typesPath = fileURLToPath(new URL("../../../packages/core/src/types.ts", import.meta.url));
const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

const program = ts.createProgram([typesPath], { strict: true, noEmit: true });
const checker = program.getTypeChecker();
const source = program.getSourceFile(typesPath);
if (!source) throw new Error(`cannot read ${typesPath}`);

function declared(name: string): ts.Type {
  const node = source?.statements.find(
    (s): s is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
      (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name.text === name,
  );
  if (!node) throw new Error(`${name} is not declared in types.ts`);
  return checker.getTypeAtLocation(node.name);
}

function fields(type: ts.Type): string[] {
  return checker
    .getPropertiesOfType(type)
    .map((p) => (p.flags & ts.SymbolFlags.Optional ? `${p.name}?` : p.name));
}

const contentFields = new Set(fields(declared("MessageContent")));

/** `type` literal(s) of a union member -> its fields, with MessageContent's own fields folded into one marker. */
const fromTypes = new Map<string, string[]>();
const union = declared("WhatsAppCallbackEvent");
for (const member of union.isUnion() ? union.types : [union]) {
  const typeProp = member.getProperty("type");
  if (!typeProp) throw new Error("a WhatsAppCallbackEvent member has no `type`");
  const literal = checker.typeToString(checker.getTypeOfSymbol(typeProp));
  const own = fields(member).filter((f) => f !== "type");
  const hasContent = [...contentFields].every((f) => own.includes(f));
  fromTypes.set(
    literal,
    (hasContent ? [...own.filter((f) => !contentFields.has(f)), "& MessageContent"] : own).sort(),
  );
}

const block = fences(readme).find((f) => f.lang === "ts" && f.code.includes('type: "reply"'));
const fromReadme = new Map<string, string[]>();
for (const line of block?.code.split("\n") ?? []) {
  const match = line.match(/^\| \{ type: ([^;]+); (.*?) \}( & MessageContent)?/);
  if (!match) continue;
  const names = String(match[2])
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  fromReadme.set(String(match[1]), [...names, ...(match[3] ? ["& MessageContent"] : [])].sort());
}

describe("README.md event shape", () => {
  it("lists every event type of WhatsAppCallbackEvent, and no other", () => {
    expect([...fromReadme.keys()].sort()).toEqual([...fromTypes.keys()].sort());
  });

  for (const [type, expected] of fromTypes) {
    it(`${type}: the README names the fields types.ts declares`, () => {
      expect(fromReadme.get(type), "edit the event shape block in README.md to match packages/core/src/types.ts").toEqual(expected);
    });
  }
});
