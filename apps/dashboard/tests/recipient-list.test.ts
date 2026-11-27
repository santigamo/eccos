import { describe, expect, test } from "bun:test";
import type { ListTable } from "../src/lib/list-file";
import {
  autoMapping,
  checkList,
  exampleCsv,
  type Mapping,
  skippedCount,
  skippedCsv,
  slotsOf,
} from "../src/lib/recipient-list";

const table = (rows: string[][]): ListTable => ({ name: "list.csv", rows, columns: Math.max(...rows.map((row) => row.length)) });

const positional = slotsOf({
  format: "positional",
  body: [
    { key: "1", example: "Ana" },
    { key: "2", example: "Friday" },
  ],
  buttons: [],
  headerMedia: null,
});

const named = slotsOf({
  format: "named",
  body: [
    { key: "nombre", example: "Ana" },
    { key: "dia", example: "viernes" },
  ],
  buttons: [{ index: 0, urlPrefix: "https://e.cc/o/" }],
  headerMedia: null,
});

describe("slotsOf", () => {
  test("body variables in order, then dynamic button links", () => {
    expect(named.map((slot) => [slot.id, slot.label])).toEqual([
      ["body:nombre", "{{nombre}}"],
      ["body:dia", "{{dia}}"],
      ["button:0", "Button 1 link"],
    ]);
  });
});

describe("autoMapping", () => {
  test("finds the phone column and the header, and matches named variables ignoring case, accents and spaces", () => {
    const list = table([
      ["Nombre", "Teléfono", "DÍA"],
      ["Ana", "600 111 222", "viernes"],
    ]);
    expect(autoMapping(list, named, "ES")).toEqual({
      header: true,
      phone: 1,
      sources: { "body:nombre": { column: 0 }, "body:dia": { column: 2 }, "button:0": null },
      fallback: {},
      country: "ES",
    });
  });

  test("without a header, the phone-like column and the rest in order", () => {
    const list = table([
      ["Ana", "+34 600 111 222", "Friday"],
      ["Luis", "+34 600 333 444", "Saturday"],
    ]);
    expect(autoMapping(list, positional, "ES")).toMatchObject({
      header: false,
      phone: 1,
      sources: { "body:1": { column: 0 }, "body:2": { column: 2 } },
    });
  });

  test("a positional header {{1}} maps by number", () => {
    const list = table([
      ["phone", "{{2}}", "{{1}}"],
      ["600111222", "Friday", "Ana"],
    ]);
    expect(autoMapping(list, positional, "ES").sources).toEqual({ "body:1": { column: 2 }, "body:2": { column: 1 } });
  });

  test("no phone-like column leaves the phone unset", () => {
    expect(autoMapping(table([["name", "city"], ["Ana", "Madrid"]]), positional, "ES").phone).toBeNull();
  });
});

describe("checkList", () => {
  const mapping: Mapping = {
    header: true,
    phone: 0,
    sources: { "body:1": { column: 1 }, "body:2": { column: 2 } },
    fallback: {},
    country: "ES",
  };
  const list = table([
    ["phone", "name", "day"],
    ["+34 600 111 222", "Ana", "Friday"],
    ["600 333 444", "Luis", "Saturday"],
    ["3.46E+10", "Marta", "Friday"],
    ["34600111222", "Ana", "Monday"],
    ["611 902 337", "Carmen", ""],
    ["622 000 111", "Eva\nMaría", "Sunday"],
    ["6123456789", "Tom", "Friday"],
    ["633 444 555.00", "Rosa      Mari", "Monday"],
  ]);

  test("gives every row one state, keeping the first of a repeated number", () => {
    const check = checkList(list, mapping, positional);
    expect(check.rows.map((row) => [row.row, row.state, row.reason])).toEqual([
      [1, "send", null],
      [2, "send", null],
      [3, "invalid", "Excel rewrote it"],
      [4, "duplicate", "same number as row 1"],
      [5, "missing", null],
      [6, "send", null],
      [7, "invalid", "no country code"],
      [8, "send", null],
    ]);
    expect(check.counts).toEqual({ send: 4, duplicate: 1, invalid: 2, missing: 1, too_long: 0 });
    expect(skippedCount(check)).toBe(4);
    expect(check.rows[1]).toMatchObject({ to: "+34 600 33 34 44", digits: "34600333444" });
    expect(check.rows[6]?.detail).toBe("No country code, and not a valid Spain number");
    // Six numbers lack a + (the Excel one is not a number at all); four took Spain's code.
    expect(check.noCode).toBe(6);
    expect(check.national).toBe(4);
    expect(check.decimals).toBe(1);
    expect(check.empty).toEqual({ "body:2": 1 });
    expect(check.rows[5]?.values).toEqual(["Eva María", "Sunday"]);
    expect(check.rows[7]?.values).toEqual(["Rosa Mari", "Monday"]);
    expect(check.cleaned).toBe(2);
  });

  test("an empty cell takes the fallback text, and a fixed value fills every row", () => {
    const check = checkList(list, { ...mapping, fallback: { "body:2": "soon" }, sources: { ...mapping.sources, "body:1": { fixed: "friend" } } }, positional);
    expect(check.rows[4]).toMatchObject({ state: "send", values: ["friend", "soon"] });
  });

  test("the skipped rows come back as written, with the reason", () => {
    const csv = skippedCsv(list, mapping, checkList(list, mapping, positional));
    expect(csv.split("\r\n")).toEqual([
      "phone,name,day,reason",
      "3.46E+10,Marta,Friday,invalid number: Excel turned this number into 3.46E+10. Format the column as text and export again.",
      "34600111222,Ana,Monday,duplicate: same number as row 1",
      "611 902 337,Carmen,,no value for {{2}}",
      '6123456789,Tom,Friday,"invalid number: No country code, and not a valid Spain number"',
      "",
    ]);
  });
});

test("a row whose values add up past the gateway's 8 KB is too long", () => {
  const wide = slotsOf({
    format: "positional",
    body: Array.from({ length: 10 }, (_, i) => ({ key: String(i + 1), example: null })),
    buttons: [],
    headerMedia: null,
  });
  const list = table([["600111222", ...Array.from({ length: 10 }, () => "x".repeat(900))]]);
  const sources = Object.fromEntries(wide.map((slot, i) => [slot.id, { column: i + 1 }]));
  const check = checkList(list, { header: false, phone: 0, sources, fallback: {}, country: "ES" }, wide);
  expect(check.rows[0]).toMatchObject({ state: "too_long", reason: "its values together are over 8 KB" });
});

test("exampleCsv starts a file for the template from Meta's examples", () => {
  expect(exampleCsv(named).split("\r\n")[0]).toBe("phone,nombre,dia,button 1");
  expect(exampleCsv(positional).split("\r\n")[1]).toBe("+34 600 111 222,Ana,Friday");
});
