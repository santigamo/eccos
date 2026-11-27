import { fmtCount } from "../ui";

/**
 * A pasted or dropped recipient list read into rows of cells. Pure: the page
 * hands it the bytes or the text and keeps the result in memory only.
 */

export const MAX_LIST_ROWS = 10_000;
export const MAX_LIST_BYTES = 5 * 1024 * 1024;

export interface ListTable {
  /** The file name, or null for pasted rows. */
  name: string | null;
  rows: string[][];
  columns: number;
}

export type ListRefusal =
  | { kind: "spreadsheet" }
  | { kind: "too_large"; bytes: number }
  | { kind: "too_many_rows"; rows: number }
  | { kind: "empty" };

const SPREADSHEET = /\.(xlsx|xlsm|xls|numbers|ods)$/i;
/** ZIP (xlsx, numbers, ods) and OLE (xls) signatures. */
const SPREADSHEET_MAGIC = [
  [0x50, 0x4b, 0x03, 0x04],
  [0xd0, 0xcf, 0x11, 0xe0],
];

export function isSpreadsheet(name: string, bytes: Uint8Array): boolean {
  return SPREADSHEET.test(name) || SPREADSHEET_MAGIC.some((magic) => magic.every((byte, i) => bytes[i] === byte));
}

/** UTF-8 with or without a BOM; Windows-1252 (what Excel exports in Spain) when it is not UTF-8. */
export function decodeList(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const DELIMITERS = ["\t", ";", ","] as const;

/** Tab (a spreadsheet paste), `;` (Spanish Excel) or `,`: the one splitting the first lines most evenly. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 20);
  let best = ",";
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => line.replace(/"[^"]*"/g, "").split(delimiter).length - 1);
    const first = counts[0] ?? 0;
    const score = first > 0 ? counts.filter((count) => count === first).length : 0;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180: quoted fields may hold the delimiter, quotes ("") and line breaks. Blank lines are dropped. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else cell += char;
  }
  endRow();
  return rows;
}

/** The text as a table, or why it cannot be one. A header row, if any, is still in `rows`. */
export function readList(text: string, name: string | null): ListTable | ListRefusal {
  const rows = parseDelimited(text, sniffDelimiter(text)).map((row) => row.map((cell) => cell.trim()));
  if (rows.length === 0) return { kind: "empty" };
  // One row over the limit may be the header; the page counts data rows once it knows.
  if (rows.length > MAX_LIST_ROWS + 1) return { kind: "too_many_rows", rows: rows.length };
  return { name, rows, columns: Math.max(...rows.map((row) => row.length)) };
}

/** A dropped or chosen file, read the same way as a paste. */
export function readListFile(name: string, bytes: Uint8Array): ListTable | ListRefusal {
  if (isSpreadsheet(name, bytes)) return { kind: "spreadsheet" };
  if (bytes.length > MAX_LIST_BYTES) return { kind: "too_large", bytes: bytes.length };
  return readList(decodeList(bytes), name);
}

export function isRefusal(result: ListTable | ListRefusal): result is ListRefusal {
  return "kind" in result;
}

export function listRefusalCopy(refusal: ListRefusal): string {
  switch (refusal.kind) {
    case "spreadsheet":
      return "This is a spreadsheet file, which the console cannot read. Copy the cells and paste them here, or export the sheet as CSV.";
    case "too_large":
      return `This file is ${Math.ceil(refusal.bytes / 1024 / 1024)} MB. A list of 10,000 rows is usually under 1 MB. Check that it is the right file.`;
    case "too_many_rows":
      return `This list has ${fmtCount(refusal.rows)} rows. A broadcast holds up to ${fmtCount(MAX_LIST_ROWS)}. Split it into two files and send two broadcasts.`;
    case "empty":
      return "The console could not read any rows from this.";
  }
}
