import type { TemplateVariables } from "@eccos/core/template-rules";
import type { ListTable } from "./list-file";
import { type CountryCode, phoneProblemDetail, PHONE_PROBLEMS, readPhone } from "./phone-number";

/**
 * A recipient list checked against a template: which column is the phone,
 * which fills each variable, and what happens to every row. Pure, so each rule
 * is asserted without a DOM.
 */

/** One thing the template needs per message: a body variable or a dynamic button link. */
export interface Slot {
  id: string;
  kind: "body" | "button";
  /** The body variable's key ("1" or a name), or the button's 0-based index. */
  key: string;
  label: string;
  /** Meta's stored example, the only thing that identifies a positional variable. */
  example: string | null;
}

export function slotsOf(vars: TemplateVariables): Slot[] {
  return [
    ...vars.body.map(({ key, example }) => ({ id: `body:${key}`, kind: "body" as const, key, label: `{{${key}}}`, example })),
    ...vars.buttons.map((slot, n) => ({
      id: `button:${slot.index}`,
      kind: "button" as const,
      key: String(slot.index),
      label: `Button ${n + 1} link`,
      example: slot.urlPrefix ? `${slot.urlPrefix}…` : null,
    })),
  ];
}

/** Where a slot's value comes from: a column of the list, one text for everyone, or nothing yet. */
export type Source = { column: number } | { fixed: string } | null;

export interface Mapping {
  header: boolean;
  phone: number | null;
  sources: Record<string, Source>;
  /** The text used for an empty cell of a column-mapped slot; without one the row is skipped. */
  fallback: Record<string, string>;
  country: CountryCode | null;
}

export type RowState = "send" | "duplicate" | "invalid" | "missing" | "too_long";

export interface RowCheck {
  /** 1-based, counting data rows only. */
  row: number;
  /** The phone cell as written. */
  raw: string;
  /** The normalised number, or the cell when it is not one. */
  to: string;
  digits: string | null;
  /** One per slot, in slot order; "" where the row has no value. */
  values: string[];
  state: RowState;
  /** Beside the tag: "same number as row 1", "Excel rewrote it". */
  reason: string | null;
  /** The long reading, for the cell's title and the skipped-rows file. */
  detail: string | null;
}

export interface ListCheck {
  rows: RowCheck[];
  counts: Record<RowState, number>;
  /** Rows that took the chosen country code. */
  national: number;
  /** Rows with an empty cell, per column-mapped slot. */
  empty: Record<string, number>;
  /** Rows whose values held line breaks or tabs, sent as spaces. */
  cleaned: number;
}

/** Meta's ceiling for one parameter. */
const MAX_VALUE_LENGTH = 1024;
const PHONE_HEADER = /phone|tel|mobile|m[oó]vil|whats\s?app|n[uú]mero|celular|cell/i;

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s_{}]/g, "");

export function dataRows(table: ListTable, header: boolean): string[][] {
  return header ? table.rows.slice(1) : table.rows;
}

/** A first guess the operator always sees and can change. */
export function autoMapping(table: ListTable, slots: Slot[], country: CountryCode | null): Mapping {
  const first = table.rows[0] ?? [];
  const sample = table.rows.slice(1, 51);
  const columns = Array.from({ length: table.columns }, (_, i) => i);
  const phoneLike = (column: number) =>
    sample.length > 0 && sample.filter((row) => readPhone(row[column] ?? "", country).ok).length / sample.length >= 0.6;
  const named = columns.find((column) => PHONE_HEADER.test(first[column] ?? ""));
  const phone = named ?? columns.find(phoneLike) ?? (table.columns === 1 ? 0 : null);
  const header =
    phone === null ? first.some((cell) => /[a-z]/i.test(cell)) : !readPhone(first[phone] ?? "", country).ok && first[phone] !== "";

  const free = columns.filter((column) => column !== phone);
  const sources: Record<string, Source> = {};
  for (const slot of slots) {
    const wanted = slot.kind === "body" ? normalize(slot.key) : `button${Number(slot.key) + 1}`;
    const match = header ? free.find((column) => normalize(first[column] ?? "") === wanted) : undefined;
    sources[slot.id] = match === undefined ? null : { column: match };
  }
  const bodySlots = slots.filter((slot) => slot.kind === "body");
  if (bodySlots.every((slot) => sources[slot.id] === null) && free.length === bodySlots.length) {
    bodySlots.forEach((slot, i) => {
      sources[slot.id] = { column: free[i] as number };
    });
  }
  return { header, phone, sources, fallback: {}, country };
}

export function checkList(table: ListTable, mapping: Mapping, slots: Slot[]): ListCheck {
  const counts: Record<RowState, number> = { send: 0, duplicate: 0, invalid: 0, missing: 0, too_long: 0 };
  const empty: Record<string, number> = {};
  const seen = new Map<string, number>();
  let national = 0;
  let cleaned = 0;

  const rows = dataRows(table, mapping.header).map((cells, i): RowCheck => {
    const row = i + 1;
    const raw = mapping.phone === null ? "" : (cells[mapping.phone] ?? "");
    const phone = readPhone(raw, mapping.country);
    let wasCleaned = false;
    let missing: string | null = null;
    const values = slots.map((slot) => {
      const source = mapping.sources[slot.id];
      const cell = !source ? "" : "fixed" in source ? source.fixed : (cells[source.column] ?? "");
      const value = cell.replace(/[\r\n\t]+/g, " ").trim();
      if (value !== cell.trim()) wasCleaned = true;
      if (value || !source || "fixed" in source) return value;
      empty[slot.id] = (empty[slot.id] ?? 0) + 1;
      const fallback = mapping.fallback[slot.id]?.trim();
      if (fallback) return fallback;
      missing ??= slot.label;
      return "";
    });
    if (wasCleaned) cleaned++;

    const base = { row, raw, values };
    let check: RowCheck;
    if (!phone.ok) {
      check = { ...base, to: raw, digits: null, state: "invalid", reason: PHONE_PROBLEMS[phone.reason], detail: phoneProblemDetail(phone.reason, raw) };
    } else if (missing) {
      check = { ...base, to: phone.display, digits: phone.digits, state: "missing", reason: null, detail: `no value for ${missing}` };
    } else if (values.some((value) => value.length > MAX_VALUE_LENGTH)) {
      const detail = "a value is over 1,024 characters";
      check = { ...base, to: phone.display, digits: phone.digits, state: "too_long", reason: detail, detail };
    } else if (seen.has(phone.digits)) {
      const detail = `same number as row ${seen.get(phone.digits)}`;
      check = { ...base, to: phone.display, digits: phone.digits, state: "duplicate", reason: detail, detail };
    } else {
      seen.set(phone.digits, row);
      check = { ...base, to: phone.display, digits: phone.digits, state: "send", reason: null, detail: null };
    }
    if (phone.ok && phone.national) national++;
    counts[check.state]++;
    return check;
  });
  return { rows, counts, national, empty, cleaned };
}

export const SKIPPED_STATES: RowState[] = ["duplicate", "invalid", "missing", "too_long"];

export function skippedCount(check: ListCheck): number {
  return SKIPPED_STATES.reduce((sum, state) => sum + check.counts[state], 0);
}

/** The state word on a skipped row's tag. */
export const STATE_TAGS: Record<Exclude<RowState, "send">, string> = {
  duplicate: "duplicate",
  invalid: "invalid number",
  missing: "missing value",
  too_long: "too long",
};

const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const csvLine = (cells: string[]) => cells.map(csvCell).join(",");

/** The rows that will not be sent, as written, with the reason beside each: fix them and send them again. */
export function skippedCsv(table: ListTable, mapping: Mapping, check: ListCheck): string {
  const width = table.columns;
  const header = mapping.header
    ? Array.from({ length: width }, (_, i) => table.rows[0]?.[i] ?? "")
    : Array.from({ length: width }, (_, i) => `column ${i + 1}`);
  const rows = dataRows(table, mapping.header);
  const lines = check.rows
    .filter((row) => row.state !== "send")
    .map((row) => {
      const cells = rows[row.row - 1] ?? [];
      const reason = row.state === "missing" ? (row.detail ?? "missing value") : `${STATE_TAGS[row.state as Exclude<RowState, "send">]}: ${row.detail}`;
      return csvLine([...Array.from({ length: width }, (_, i) => cells[i] ?? ""), reason]);
    });
  return `${[csvLine([...header, "reason"]), ...lines].join("\r\n")}\r\n`;
}

/** A starting file for this template: a phone column and one per variable, filled with Meta's examples. */
export function exampleCsv(slots: Slot[]): string {
  const header = ["phone", ...slots.map((slot) => (slot.kind === "body" ? slot.key : `button ${Number(slot.key) + 1}`))];
  const row = (phone: string) => [phone, ...slots.map((slot) => (slot.kind === "body" ? (slot.example ?? "") : ""))];
  return `${[header, row("+34 600 111 222"), row("+34 600 333 444")].map(csvLine).join("\r\n")}\r\n`;
}
