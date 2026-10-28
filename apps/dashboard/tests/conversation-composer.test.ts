import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import type { CursorPage, MessageRecord } from "../src/server/gateway";

/**
 * The reply box's rules, asserted without a DOM (`components/conversations/
 * conversation-composer.tsx`, rules in `lib/conversations.ts`).
 *
 * WHAT IS PINNED. The 24-hour window and how long it has left, the walk back
 * to the customer's newest inbound message, the Enter / Shift+Enter rule, and
 * the outcome of a reply: a sent one, a refused one named by its code, and a
 * boundary failure keeping its own copy. The send itself is a fake server
 * function, so the request and the outcome are both visible here.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { submitReply } = await import("../src/components/conversations/conversation-composer");
const { INBOUND_LOOKUP_PAGES, SERVICE_WINDOW_MS, isSendKey, lastInboundAt, serviceWindowOf, threadPhoneNumberId } =
  await import("../src/lib/conversations");

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;
const WABA = "waba-a";
const CUSTOMER = "34600111222";

function message(overrides: Partial<MessageRecord> & Pick<MessageRecord, "id">): MessageRecord {
  return {
    waId: CUSTOMER,
    direction: "in",
    origin: "live",
    type: "text",
    text: "hola",
    content: null,
    at: NOW,
    status: null,
    error: null,
    targetId: null,
    phoneNumberId: "phone-a",
    ...overrides,
  };
}

/** A page oldest first, as the gateway returns it, with the cursor that leads to older messages. */
const page = (items: MessageRecord[], nextCursor: string | null = null): CursorPage<MessageRecord> => ({
  items,
  nextCursor,
});

describe("serviceWindowOf", () => {
  test("the window is open for 24 hours after the customer's last message, and says how long is left", () => {
    expect(serviceWindowOf(NOW - 21 * HOUR, NOW)).toEqual({ open: true, label: "Window open, 3 h left" });
    expect(serviceWindowOf(NOW - 23 * HOUR - 30 * 60_000, NOW)).toEqual({ open: true, label: "Window open, 30 min left" });
  });

  test("the window is closed at exactly 24 hours and stays closed after", () => {
    expect(serviceWindowOf(NOW - SERVICE_WINDOW_MS, NOW)).toEqual({
      open: false,
      label: "Window closed: templates only",
    });
    expect(serviceWindowOf(NOW - 3 * SERVICE_WINDOW_MS, NOW).open).toBe(false);
  });

  test("no inbound message at all is a closed window, not an open one", () => {
    expect(serviceWindowOf(null, NOW)).toEqual({ open: false, label: "Window closed: templates only" });
  });

  test("a last-minute window reads in minutes, never as zero", () => {
    // 1 ms left must not read as "0 min left"; the window is still open.
    expect(serviceWindowOf(NOW - SERVICE_WINDOW_MS + 1, NOW)).toEqual({ open: true, label: "Window open, 1 min left" });
  });
});

describe("lastInboundAt", () => {
  test("reads the newest page first: the customer's last inbound message is the one in it", async () => {
    const newest = page([
      message({ id: "in-old", at: NOW - 2 * HOUR }),
      message({ id: "out", direction: "out", at: NOW - HOUR }),
      message({ id: "in-new", at: NOW - 30 * 60_000 }),
      message({ id: "out-new", direction: "out", at: NOW - 10 * 60_000 }),
    ]);
    const fetchOlder = async () => {
      throw new Error("the newest page had an inbound message, so no older page is read");
    };
    expect(await lastInboundAt(newest, fetchOlder, NOW)).toBe(NOW - 30 * 60_000);
  });

  test("walks back through older pages when the newest page is all outbound", async () => {
    // Twenty replies since the customer last wrote: the window is open, and
    // the page the thread opened on has no inbound message in it.
    const newest = page(
      Array.from({ length: 3 }, (_, i) => message({ id: `out-${i}`, direction: "out", at: NOW - (i + 1) * 60_000 })).reverse(),
      "cursor-1",
    );
    const older = page([message({ id: "in-older", at: NOW - 5 * HOUR })]);
    const cursors: string[] = [];
    const fetchOlder = async (cursor: string) => {
      cursors.push(cursor);
      return older;
    };
    expect(await lastInboundAt(newest, fetchOlder, NOW)).toBe(NOW - 5 * HOUR);
    expect(cursors).toEqual(["cursor-1"]);
  });

  test("stops at the window's edge: an older page cannot hold a message inside the window", async () => {
    // Everything on this page is already older than 24 hours, so nothing
    // further back can be inside the window and the walk does not read on.
    const old = page([message({ id: "out-old", direction: "out", at: NOW - 30 * HOUR })], "cursor-1");
    let reads = 0;
    expect(
      await lastInboundAt(old, async () => {
        reads += 1;
        return page([]);
      }, NOW),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  test("gives up after a bounded number of pages rather than walking a long history", async () => {
    const endless = (cursor: string) =>
      Promise.resolve(page([message({ id: cursor, direction: "out", at: NOW - HOUR })], `${cursor}+`));
    let reads = 0;
    const fetchOlder = async (cursor: string) => {
      reads += 1;
      return endless(cursor);
    };
    expect(await lastInboundAt(page([message({ id: "start", direction: "out", at: NOW - HOUR })], "c"), fetchOlder, NOW)).toBeNull();
    expect(reads).toBe(INBOUND_LOOKUP_PAGES - 1);
  });

  test("a failed older read ends the walk with no inbound message found", async () => {
    const newest = page([message({ id: "out", direction: "out", at: NOW - HOUR })], "cursor-1");
    expect(await lastInboundAt(newest, async () => null, NOW)).toBeNull();
  });
});

describe("isSendKey", () => {
  test("Enter sends; Shift+Enter is left to the textarea as a newline", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(isSendKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
  });

  test("an Enter that ends an IME composition is not a send, and other keys are not one either", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isSendKey({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });
});

describe("threadPhoneNumberId", () => {
  test("replies go out from the number the newest message named", () => {
    expect(
      threadPhoneNumberId([
        message({ id: "a", phoneNumberId: "phone-old" }),
        message({ id: "b", phoneNumberId: "phone-new" }),
        message({ id: "c", phoneNumberId: null }),
      ]),
    ).toBe("phone-new");
  });

  test("a thread with no number on any message has no sender", () => {
    expect(threadPhoneNumberId([message({ id: "a", phoneNumberId: null })])).toBeNull();
    expect(threadPhoneNumberId([])).toBeNull();
  });
});

describe("submitReply", () => {
  const target = { wabaId: WABA, phoneNumberId: "phone-a", waId: CUSTOMER };

  /** A fake of the `sendText` server function: records each request and answers with `result`. */
  function fakeSend(result: unknown) {
    const calls: unknown[] = [];
    const send = ((input: unknown) => {
      calls.push(input);
      return Promise.resolve(result);
    }) as unknown as Parameters<typeof submitReply>[0];
    return { calls, send };
  }

  test("a sent reply is sent to the customer's number, from the thread's number, with the typed text", async () => {
    const { calls, send } = fakeSend({ ok: true, data: { ok: true, messageId: "wamid.1" } });
    expect(await submitReply(send, target, "Hola")).toEqual({ sent: true });
    expect(calls).toEqual([{ data: { wabaId: WABA, phoneNumberId: "phone-a", to: CUSTOMER, text: "Hola" } }]);
  });

  test("a closed window names itself, and Meta's sentence rides along as the secondary line", async () => {
    const { send } = fakeSend({
      ok: true,
      data: { ok: false, code: "window_closed", detail: "more than 24 hours have passed" },
    });
    expect(await submitReply(send, target, "Hola")).toEqual({
      sent: false,
      title: "Outside the 24-hour window",
      detail:
        "WhatsApp only allows free text within 24 hours of the customer's last message. Send an approved template instead.",
      secondary: "more than 24 hours have passed",
    });
  });

  test("a refused send keeps its own copy, and only the codes Meta explains better carry its sentence", async () => {
    const graph = await submitReply(
      fakeSend({ ok: true, data: { ok: false, code: "graph", detail: "Meta says no" } }).send,
      target,
      "Hola",
    );
    expect(graph).toMatchObject({ sent: false, secondary: "Meta says no" });

    const noPhone = await submitReply(
      fakeSend({ ok: true, data: { ok: false, code: "no_phone", detail: "phone is gone" } }).send,
      target,
      "Hola",
    );
    expect(noPhone).toMatchObject({ sent: false, title: "Number no longer available", secondary: null });
  });

  test("a boundary failure keeps the failure's own copy, and the text is not treated as sent", async () => {
    const outcome = await submitReply(
      fakeSend({ ok: false, kind: "unreachable", error: "binding down" }).send,
      target,
      "Hola",
    );
    expect(outcome.sent).toBe(false);
    expect(outcome).toMatchObject({ secondary: null });
  });
});
