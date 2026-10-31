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
const {
  SERVICE_WINDOW_MS,
  composerWindowOf,
  isSendKey,
  serviceWindowOf,
  threadPhoneNumberId,
} = await import("../src/lib/conversations");

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

describe("composerWindowOf", () => {
  test("a refused free-text send closes the window for the inbound it was refused on", () => {
    expect(composerWindowOf(NOW - HOUR, NOW - HOUR, NOW).open).toBe(false);
  });

  test("the customer writing again reopens the window after a refusal", () => {
    expect(composerWindowOf(NOW - HOUR, NOW - 2 * HOUR, NOW).open).toBe(true);
  });

  test("an open window closes once its 24 hours have passed, with no refusal at all", () => {
    expect(composerWindowOf(NOW - SERVICE_WINDOW_MS, null, NOW).open).toBe(false);
    expect(composerWindowOf(NOW - HOUR, null, NOW + SERVICE_WINDOW_MS).open).toBe(false);
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

  test("a reply to a BSUID customer goes to the BSUID as-is", async () => {
    const { calls, send } = fakeSend({ ok: true, data: { ok: true, messageId: "wamid.2" } });
    expect(await submitReply(send, { ...target, waId: "US.13491208655302741918" }, "Hola")).toEqual({ sent: true });
    expect(calls).toEqual([
      { data: { wabaId: WABA, phoneNumberId: "phone-a", to: "US.13491208655302741918", text: "Hola" } },
    ]);
  });

  test("a closed window names itself, and Meta's sentence rides along as the secondary line", async () => {
    const { send } = fakeSend({
      ok: true,
      data: { ok: false, code: "window_closed", detail: "more than 24 hours have passed" },
    });
    expect(await submitReply(send, target, "Hola")).toEqual({
      sent: false,
      windowClosed: true,
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
    expect(graph).toMatchObject({ sent: false, secondary: "Meta says no", windowClosed: false });

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
