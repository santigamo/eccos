import { describe, expect, test } from "bun:test";
import {
  eventCountEntries,
  eventReading,
  messageRefText,
  messageSummary,
  messageSummaryText,
  prettyJson,
  wamidTail,
} from "../src/lib/logs";

/**
 * How the two logs READ a stored row (`src/lib/logs.ts`).
 *
 * Every assertion here is a bug that shipped. The old Inbound log printed a
 * wamid under a column headed "Summary", showed the workspace's own phone id as
 * the only party, and counted delivery receipts for our own sends as inbound
 * traffic. Pure functions are where those decisions now live, so they can be
 * pinned without a browser.
 */

const TEMPLATE_REQUEST = JSON.stringify({
  to: "34600000000",
  type: "template",
  template: { name: "cita_encontrada", language: { code: "es" } },
});

describe("messageSummary", () => {
  test("names a message by its row id, its kind and its template", () => {
    expect(messageSummaryText(messageSummary(1042, TEMPLATE_REQUEST))).toBe(
      "#1042 · template cita_encontrada · es",
    );
  });

  test("the short form drops everything but the name an operator would quote", () => {
    expect(messageRefText(messageSummary(1042, TEMPLATE_REQUEST))).toBe("#1042 cita_encontrada");
  });

  test("a non-template send says what it is rather than pretending", () => {
    const text = JSON.stringify({ to: "34600000000", type: "text", text: { body: "hi" } });
    expect(messageSummaryText(messageSummary(7, text))).toBe("#7 · text");
  });

  test("a request the console cannot parse still yields a usable name", () => {
    // The id always works, which is why the line leads with it: a row whose
    // body was redacted by retention is still identifiable.
    expect(messageSummaryText(messageSummary(9, ""))).toBe("#9 · message");
  });
});

describe("eventReading", () => {
  test("a reply names who wrote and what they said", () => {
    const payload = JSON.stringify({
      type: "reply",
      from: "34600000000",
      messageId: "wamid.M1",
      text: "hola",
      at: 1,
    });
    expect(eventReading("reply", payload)).toEqual({
      kind: "reply",
      family: "message",
      party: { direction: "from", phone: "34600000000" },
      detail: "hola",
    });
  });

  test("an echo names the recipient, because the business is the sender", () => {
    const payload = JSON.stringify({ type: "echo", to: "34600000001", messageId: "m", text: "ok", at: 1 });
    expect(eventReading("echo", payload).party).toEqual({ direction: "to", phone: "34600000001" });
  });

  test("a status callback has NO detail — and never a wamid as one", () => {
    // THE BUG THIS PINS. `inboundSummary` returned `text` if present else
    // `transportMessageId`, and a status event has no text — so the column
    // headed "Summary" printed ~60 characters of base64 on most rows.
    const payload = JSON.stringify({ type: "delivered", transportMessageId: "wamid.LONG", at: 1 });
    const reading = eventReading("delivered", payload);
    expect(reading.detail).toBeNull();
    expect(reading.party).toBeNull();
    expect(reading.family).toBe("status");
  });

  test("a failed status reads as the Graph code and Meta's own sentence", () => {
    const payload = JSON.stringify({
      type: "failed",
      transportMessageId: "wamid.X",
      errorCode: "131047",
      errorMessage: "Re-engagement message",
      at: 1,
    });
    const reading = eventReading("failed", payload);
    expect(reading.detail).toBe("131047 · Re-engagement message");
    // The only family that spends a semantic colour (data rule 1).
    expect(reading.family).toBe("problem");
  });

  test("unparseable storage degrades to the kind alone", () => {
    expect(eventReading("reply", "{oops")).toEqual({
      kind: "reply",
      family: "message",
      party: null,
      detail: null,
    });
  });
});

describe("eventCountEntries", () => {
  test("the sentence that kills the misread", () => {
    // Two template sends, no customer traffic. "2 inbound events" said two
    // people had written in; spelled out, the zero is the information.
    expect(eventCountEntries({ delivered: 2 })).toEqual([
      { kind: "reply", label: "replies", n: 0, family: "message" },
      { kind: "echo", label: "echoes", n: 0, family: "message" },
      { kind: "delivered", label: "delivered", n: 2, family: "status" },
    ]);
  });

  test("a status kind at zero drops out; reply and echo never do", () => {
    // Nobody needs to be told no read receipts have arrived. Being told nobody
    // has written in is the whole point of the row.
    const kinds = eventCountEntries({ reply: 3, read: 0 }).map((entry) => entry.kind);
    expect(kinds).toEqual(["reply", "echo"]);
  });

  test("order is fixed, so an operator's eye lands in the same place", () => {
    const kinds = eventCountEntries({ failed: 2, read: 55, delivered: 60, reply: 3 }).map(
      (entry) => entry.kind,
    );
    expect(kinds).toEqual(["reply", "echo", "delivered", "read", "failed"]);
  });

  test("a kind the parser learns later still appears", () => {
    // It is part of the total either way; silently dropping it would make the
    // parts stop adding up to the whole.
    const entries = eventCountEntries({ button: 4 });
    expect(entries.at(-1)).toEqual({ kind: "button", label: "button", n: 4, family: "status" });
  });
});

describe("wamidTail and prettyJson", () => {
  test("the TAIL of a wamid, because Meta's prefix distinguishes nothing", () => {
    expect(wamidTail("wamid.HBgLMzQ2MDAwMDAwMDAVAgARGBI5QUY")).toBe("…VAgARGBI5QUY");
    // Short enough to read whole: no ellipsis, because there is nothing to hide.
    expect(wamidTail("short")).toBe("short");
  });

  test("JSON is indented, and unparseable text comes back as itself", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("not json")).toBe("not json");
    expect(prettyJson("")).toBe("");
  });
});
