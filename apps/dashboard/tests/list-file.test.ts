import { describe, expect, test } from "bun:test";
import {
  decodeList,
  listRefusalCopy,
  parseDelimited,
  readList,
  readListFile,
  sniffDelimiter,
} from "../src/lib/list-file";

const bytes = (text: string) => new TextEncoder().encode(text);
const MAX = 10_000;

describe("sniffDelimiter", () => {
  test("a spreadsheet paste is tab-separated; Spanish Excel exports ;", () => {
    expect(sniffDelimiter("+34 600 111 222\tAna\tFriday\n+34 600 333 444\tLuis\tSaturday")).toBe("\t");
    expect(sniffDelimiter("phone;name\n600111222;Ana, la de siempre\n600333444;Luis")).toBe(";");
    expect(sniffDelimiter('phone,name\n600111222,"Ana; Luis"\n600333444,Eva')).toBe(",");
  });

  test("one column (one number per line) reads as one column", () => {
    expect(readList("600111222\n600333444\n", null, MAX)).toMatchObject({ rows: [["600111222"], ["600333444"]], columns: 1 });
  });
});

describe("parseDelimited", () => {
  test("quoted fields keep delimiters, doubled quotes and line breaks; blank lines go", () => {
    expect(parseDelimited('a,"b, c","say ""hi""","two\r\nlines"\r\n\r\nd,e,f,g\n', ",")).toEqual([
      ["a", "b, c", 'say "hi"', "two\r\nlines"],
      ["d", "e", "f", "g"],
    ]);
  });
});

test("an unclosed quote is refused with the line it opened on, never swallowing the rest", () => {
  expect(parseDelimited('a,b\n"c,d\ne,f\n', ",")).toEqual({ unclosedQuote: 2 });
  expect(readList('phone,name\n600111222,Ana\n600333444,"Luis\n600555666,Eva', null, MAX)).toEqual({
    kind: "unclosed_quote",
    line: 3,
  });
  expect(listRefusalCopy({ kind: "unclosed_quote", line: 3 })).toContain("A quote opened on line 3 is never closed");
});

describe("decodeList", () => {
  test("reads Excel's Unicode Text, UTF-16 with its BOM", () => {
    const le = new Uint8Array([0xff, 0xfe, ...Array.from("móvil\tAna").flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(decodeList(le)).toBe("móvil\tAna");
    const be = new Uint8Array([0xfe, 0xff, ...Array.from("Ana").flatMap((c) => [0, c.charCodeAt(0)])]);
    expect(decodeList(be)).toBe("Ana");
  });

  test("drops a UTF-8 BOM, and falls back to Windows-1252", () => {
    expect(decodeList(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("teléfono")]))).toBe("teléfono");
    expect(decodeList(new Uint8Array([0x6d, 0xf3, 0x76, 0x69, 0x6c]))).toBe("móvil");
  });
});

describe("readListFile", () => {
  test("refuses a spreadsheet by name or by signature", () => {
    expect(readListFile("clients.xlsx", bytes("x"), MAX)).toEqual({ kind: "spreadsheet" });
    expect(readListFile("clients.csv", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]), MAX)).toEqual({ kind: "spreadsheet" });
  });

  test("refuses an oversized file, too many rows, or nothing at all", () => {
    expect(readListFile("big.csv", new Uint8Array(6 * 1024 * 1024), MAX)).toMatchObject({ kind: "too_large" });
    const many = Array.from({ length: MAX + 2 }, (_, i) => `6001${i}`).join("\n");
    expect(readListFile("many.csv", bytes(many), MAX)).toEqual({ kind: "too_many_rows", rows: MAX + 2, max: MAX });
    expect(readListFile("empty.csv", bytes("\n \n"), MAX)).toEqual({ kind: "empty" });
  });

  test("reads a CSV with its name and widest row", () => {
    expect(readListFile("a.csv", bytes("phone,name\n600111222,Ana,extra"), MAX)).toEqual({
      name: "a.csv",
      rows: [["phone", "name"], ["600111222", "Ana", "extra"]],
      columns: 3,
    });
  });
});

test("each refusal has its sentence", () => {
  expect(listRefusalCopy({ kind: "too_many_rows", rows: 12_400, max: 10_000 })).toBe(
    "This list has 12,400 rows. A broadcast holds up to 10,000. Split it into two files and send two broadcasts.",
  );
  expect(listRefusalCopy({ kind: "too_large", bytes: 14 * 1024 * 1024 })).toContain("This file is 14 MB.");
});
