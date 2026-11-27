import { describe, expect, test } from "bun:test";
import {
  decodeList,
  listRefusalCopy,
  MAX_LIST_ROWS,
  parseDelimited,
  readList,
  readListFile,
  sniffDelimiter,
} from "../src/lib/list-file";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("sniffDelimiter", () => {
  test("a spreadsheet paste is tab-separated; Spanish Excel exports ;", () => {
    expect(sniffDelimiter("+34 600 111 222\tAna\tFriday\n+34 600 333 444\tLuis\tSaturday")).toBe("\t");
    expect(sniffDelimiter("phone;name\n600111222;Ana, la de siempre\n600333444;Luis")).toBe(";");
    expect(sniffDelimiter('phone,name\n600111222,"Ana; Luis"\n600333444,Eva')).toBe(",");
  });

  test("one column (one number per line) reads as one column", () => {
    expect(readList("600111222\n600333444\n", null)).toMatchObject({ rows: [["600111222"], ["600333444"]], columns: 1 });
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

describe("decodeList", () => {
  test("drops a UTF-8 BOM, and falls back to Windows-1252", () => {
    expect(decodeList(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("teléfono")]))).toBe("teléfono");
    expect(decodeList(new Uint8Array([0x6d, 0xf3, 0x76, 0x69, 0x6c]))).toBe("móvil");
  });
});

describe("readListFile", () => {
  test("refuses a spreadsheet by name or by signature", () => {
    expect(readListFile("clients.xlsx", bytes("x"))).toEqual({ kind: "spreadsheet" });
    expect(readListFile("clients.csv", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]))).toEqual({ kind: "spreadsheet" });
  });

  test("refuses an oversized file, too many rows, or nothing at all", () => {
    expect(readListFile("big.csv", new Uint8Array(6 * 1024 * 1024))).toMatchObject({ kind: "too_large" });
    const many = Array.from({ length: MAX_LIST_ROWS + 2 }, (_, i) => `6001${i}`).join("\n");
    expect(readListFile("many.csv", bytes(many))).toEqual({ kind: "too_many_rows", rows: MAX_LIST_ROWS + 2 });
    expect(readListFile("empty.csv", bytes("\n \n"))).toEqual({ kind: "empty" });
  });

  test("reads a CSV with its name and widest row", () => {
    expect(readListFile("a.csv", bytes("phone,name\n600111222,Ana,extra"))).toEqual({
      name: "a.csv",
      rows: [["phone", "name"], ["600111222", "Ana", "extra"]],
      columns: 3,
    });
  });
});

test("each refusal has its sentence", () => {
  expect(listRefusalCopy({ kind: "too_many_rows", rows: 12_400 })).toBe(
    "This list has 12,400 rows. A broadcast holds up to 10,000. Split it into two files and send two broadcasts.",
  );
  expect(listRefusalCopy({ kind: "too_large", bytes: 14 * 1024 * 1024 })).toContain("This file is 14 MB.");
});
