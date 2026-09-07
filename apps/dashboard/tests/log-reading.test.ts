import { describe, expect, test } from "bun:test";
import {
  eventCountEntries,
  eventReading,
  messageRefText,
  messageSummary,
  messageSummaryText,
  prettyJson,
  requestReading,
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

describe("requestReading", () => {
  test("a template send is its VALUES, labelled by slot — never the template's copy", () => {
    // The stored body carries the name, the language and what was poured into
    // each slot. It does not carry one word of the body text, which only ever
    // lived at Meta, so this is a record of the send and not a preview of it.
    const reading = requestReading(
      JSON.stringify({
        to: "34600000000",
        type: "template",
        template: {
          name: "cita_encontrada",
          language: { code: "es" },
          components: [
            {
              type: "header",
              parameters: [{ type: "image", image: { link: "https://cdn.example/a.png" } }],
            },
            {
              type: "body",
              parameters: [
                { type: "text", text: "Ada" },
                { type: "text", text: "Renovación DNI" },
              ],
            },
            {
              type: "button",
              sub_type: "url",
              index: "0",
              parameters: [{ type: "text", text: "abc123" }],
            },
          ],
        },
      }),
    );
    expect(reading?.template).toEqual({ name: "cita_encontrada", language: "es" });
    // Header, then body, then buttons — the order Meta renders them.
    expect(reading?.values).toEqual([
      { slot: "Header", value: "image · https://cdn.example/a.png", mono: true },
      { slot: "{{1}}", value: "Ada", mono: false },
      { slot: "{{2}}", value: "Renovación DNI", mono: false },
      // Mono: a button fill is a URL fragment an operator pastes, not prose.
      { slot: "Button 1 URL", value: "abc123", mono: true },
    ]);
    // A template send has no text of its own, and claiming one would be the
    // reconstruction this whole reading refuses to make.
    expect(reading?.text).toBeNull();
  });

  test("a free-form text send DOES carry its message, so it is shown", () => {
    // `POST /v1/wabas/:wabaId/messages` stores the caller's body verbatim, and
    // for a `text` send that body is the message.
    const reading = requestReading(
      JSON.stringify({ to: "34600000000", type: "text", text: { body: "on my way" } }),
    );
    expect(reading?.text).toBe("on my way");
    expect(reading?.values).toEqual([]);
  });

  test("a media send names the asset and shows the caption as the message", () => {
    const reading = requestReading(
      JSON.stringify({
        to: "34600000000",
        type: "document",
        document: { link: "https://cdn.example/f.pdf", filename: "cita.pdf", caption: "Adjunto" },
      }),
    );
    expect(reading?.text).toBe("Adjunto");
    expect(reading?.values).toEqual([
      { slot: "Link", value: "https://cdn.example/f.pdf", mono: true },
      { slot: "Filename", value: "cita.pdf", mono: false },
    ]);
  });

  test("a parameter this cannot read still costs its slot number", () => {
    // Meta numbers body placeholders by POSITION. Skipping an unreadable one
    // would renumber every value after it and put the right text against the
    // wrong `{{n}}` — a quiet lie on a forensic surface.
    const reading = requestReading(
      JSON.stringify({
        type: "template",
        template: {
          name: "t",
          language: { code: "es" },
          components: [
            {
              type: "body",
              parameters: [{ type: "location", location: {} }, { type: "text", text: "second" }],
            },
          ],
        },
      }),
    );
    expect(reading?.values).toEqual([{ slot: "{{2}}", value: "second", mono: false }]);
  });

  test("named parameters keep their names", () => {
    // The console's own send path only builds positional templates, but an API
    // caller can send `parameter_format: NAMED`, and `{{3}}` would be a made-up
    // number for a slot Meta calls `order_id`.
    const reading = requestReading(
      JSON.stringify({
        type: "template",
        template: {
          name: "t",
          components: [
            { type: "body", parameters: [{ type: "text", parameter_name: "order_id", text: "A-9" }] },
          ],
        },
      }),
    );
    expect(reading?.values).toEqual([{ slot: "{{order_id}}", value: "A-9", mono: false }]);
  });

  test("a swept or unreadable body reads as nothing at all, not as an empty send", () => {
    expect(requestReading("")).toBeNull();
    expect(requestReading("{oops")).toBeNull();
    expect(requestReading("null")).toBeNull();
  });

  test("a kind the console has no reading for yields no invented values", () => {
    const reading = requestReading(
      JSON.stringify({ to: "34600000000", type: "interactive", interactive: { type: "button" } }),
    );
    expect(reading?.kind).toBe("interactive");
    expect(reading?.values).toEqual([]);
    expect(reading?.text).toBeNull();
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
      text: "hola",
      errorCode: null,
      errorMessage: null,
      at: 1,
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
      text: null,
      errorCode: null,
      errorMessage: null,
      at: null,
      detail: null,
    });
  });

  test("the code and the sentence stay APART, so the sheet can label each", () => {
    // `detail` joins them for the one-line grid cell; the sheet shows the code
    // an operator quotes in a support case under its own label, and Meta's
    // sentence under Meta's name. Joining is a rendering, not the reading.
    const payload = JSON.stringify({
      type: "failed",
      transportMessageId: "wamid.X",
      errorCode: "131047",
      errorMessage: "Re-engagement message",
      at: 1_700_000_000_000,
    });
    const reading = eventReading("failed", payload);
    expect(reading.errorCode).toBe("131047");
    expect(reading.errorMessage).toBe("Re-engagement message");
    expect(reading.text).toBeNull();
  });

  test("Meta's own moment is read out, and it is not `received_at`", () => {
    // The two differ by the callback's flight time, and Meta's is the one an
    // operator compares against a customer's screenshot. It was legible only
    // inside the raw JSON before this.
    const payload = JSON.stringify({ type: "read", transportMessageId: "w", at: 1_700_000_002_000 });
    expect(eventReading("read", payload).at).toBe(1_700_000_002_000);
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
