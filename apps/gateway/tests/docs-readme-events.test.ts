import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { fences } from "./docs-md";

// README.md summarises `WhatsAppCallbackEvent` by hand. This test reads the
// union from types.ts with the compiler and fails when the summary names a
// different set of fields, and when it lists an event type,
// a suffix or a line that the union does not have.

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

/** Field names per event type in the README's event shape block, or the reasons it cannot be read. */
function readmeShapes(code: string): { shapes: Map<string, string[]>; problems: string[] } {
  const shapes = new Map<string, string[]>();
  const problems: string[] = [];
  for (const raw of code.split("\n")) {
    const line = raw.replace(/\s*\/\/.*$/, "").trim();
    if (!line.startsWith("|")) continue;
    const match = line.match(/^\| \{ type: ([^;]+); (.*?) \}(.*)$/);
    if (!match) {
      problems.push(`cannot read the line: ${line}`);
      continue;
    }
    const [, type, body, suffix] = match as unknown as [string, string, string, string];
    if (suffix.trim() !== "" && suffix.trim() !== "& MessageContent") {
      problems.push(`${type}: unknown suffix "${suffix.trim()}"; the union only intersects MessageContent`);
      continue;
    }
    if (shapes.has(type)) problems.push(`${type}: listed more than once`);
    const names = body
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    shapes.set(type, [...names, ...(suffix.trim() ? ["& MessageContent"] : [])].sort());
  }
  return { shapes, problems };
}

/** Every way the README block differs from the union; empty when it matches. */
function mismatches(code: string): string[] {
  const { shapes, problems } = readmeShapes(code);
  for (const type of fromTypes.keys()) if (!shapes.has(type)) problems.push(`${type}: missing from the README`);
  for (const [type, names] of shapes) {
    const expected = fromTypes.get(type);
    if (!expected) problems.push(`${type}: not a WhatsAppCallbackEvent type`);
    else if (names.join(",") !== expected.join(","))
      problems.push(`${type}: README has [${names.join(", ")}], types.ts declares [${expected.join(", ")}]`);
  }
  return problems;
}

const block = fences(readme).find((f) => f.lang === "ts" && f.code.includes('type: "reply"'));
if (!block) throw new Error("README.md has no ts block with the event shape");
const code = block.code;
const lineOf = (type: string) => {
  const line = code.split("\n").find((l) => l.startsWith(`| { type: "${type}";`));
  if (!line) throw new Error(`no ${type} line in the README block`);
  return line;
};

describe("README.md event shape", () => {
  it("matches WhatsAppCallbackEvent exactly", () => {
    expect(mismatches(code), "edit the event shape block in README.md to match packages/core/src/types.ts").toEqual([]);
  });

  describe("fails on", () => {
    const cases: [string, string][] = [
      ["an intersection the member does not have", code.replace(lineOf("echo"), lineOf("echo").replace(" }", " } & EventOrigin"))],
      ["a misspelled intersection", code.replace("} & MessageContent", "} & MessageContents")],
      ["an event type the union does not have", `${code}\n| { type: "deleted" }`],
      ["a stale duplicate line", code.replace(lineOf("reply"), `${lineOf("reply").replace(" phoneNumberId?;", "")}\n${lineOf("reply")}`)],
      ["a missing field", code.replace(lineOf("reply"), lineOf("reply").replace(" phoneNumberId?;", ""))],
      ["an event type the README lacks", code.replace(`${lineOf("echo")}\n`, "")],
    ];
    for (const [name, variant] of cases) {
      it(name, () => {
        expect(variant).not.toBe(code);
        expect(mismatches(variant)).not.toEqual([]);
      });
    }
  });
});
