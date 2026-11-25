import { describe, expect, test } from "bun:test";
import type { ConversationSummary, InboundRow, OutboundRow } from "@eccos/gateway-contract";
import { hoursLeft, pendingActivation, WINDOW_HOURS } from "../src/lib/activation";
import {
  arrivedMessage,
  CLOCK_SLACK_MS,
  forwardOutcome,
  replyOutcome,
  sendToOutcome,
  waLink,
} from "../src/lib/setup-test";
import type { DashboardState } from "../src/server/gateway";

/** How each setup path's live test reads success off the console's own reads. */

const START = 1_000_000_000_000;

const conversation = (over: Partial<ConversationSummary["lastMessage"]> = {}, waId = "34600111222"): ConversationSummary => ({
  waId,
  name: null,
  messageCount: 1,
  unreadCount: 1,
  markedUnread: false,
  lastMessage: { type: "text", text: "Hello, this is a test", direction: "in", at: START + 1_000, ...over },
});

const outbound = (over: Partial<OutboundRow> = {}): OutboundRow => ({
  id: 1,
  transport_message_id: "wamid.1",
  recipient: "34600111222",
  phone_number_id: "200",
  request: "{}",
  status: "sent",
  error: null,
  created_at: START + 1_000,
  trail: [],
  ...over,
});

const delivered = (at: number) => ({ type: "delivered", at, errorCode: null, deliveryStatus: null, deliveryAttempts: null });

const inbound = (over: Partial<InboundRow> = {}): InboundRow => ({
  id: 1,
  type: "reply",
  transport_message_id: null,
  message_id: "wamid.in",
  phone_number_id: "200",
  payload: JSON.stringify({ type: "reply", from: "34600111222", text: "Hello, this is a test" }),
  received_at: START + 1_000,
  delivery_status: "pending",
  delivery_attempts: 0,
  delivery_last_error: null,
  delivery_finished_at: null,
  ...over,
});

describe("path A: reply from Eccos", () => {
  test("the QR opens WhatsApp on this number with the test message typed", () => {
    expect(waLink("+34 612 345 678")).toBe("https://wa.me/34612345678?text=Hello%2C%20this%20is%20a%20test");
  });

  test("a message in since the test started has arrived; an older one or our own send has not", () => {
    expect(arrivedMessage([conversation()], START)).toEqual({ waId: "34600111222", text: "Hello, this is a test", at: START + 1_000 });
    expect(arrivedMessage([conversation({ at: START - CLOCK_SLACK_MS - 1 })], START)).toBeNull();
    expect(arrivedMessage([conversation({ direction: "out" })], START)).toBeNull();
  });

  test("the reply succeeds on Meta's delivered or read receipt, by its message id", () => {
    expect(replyOutcome([outbound()], "wamid.1")).toEqual({ state: "waiting" });
    expect(replyOutcome([outbound({ trail: [delivered(START + 5)] })], "wamid.other")).toEqual({ state: "waiting" });
    expect(replyOutcome([outbound({ trail: [delivered(START + 5)] })], "wamid.1")).toEqual({ state: "delivered", at: START + 5 });
    expect(replyOutcome([outbound({ trail: [{ ...delivered(START + 6), type: "read" }] })], "wamid.1").state).toBe("delivered");
    expect(replyOutcome([outbound({ status: "failed", error: "131047" })], "wamid.1")).toEqual({ state: "failed", error: "131047" });
  });
});

describe("path C: send from software", () => {
  test("any send to the operator's phone since the test started counts, from their terminal or from here", () => {
    const rows = [outbound({ recipient: "34600111222", trail: [delivered(START + 9)] })];
    expect(sendToOutcome(rows, "+34 600 111 222", START)).toEqual({ state: "delivered", at: START + 9 });
    expect(sendToOutcome(rows, "34699999999", START)).toEqual({ state: "waiting" });
    expect(sendToOutcome([outbound({ created_at: START - CLOCK_SLACK_MS - 1, trail: [delivered(START)] })], "34600111222", START)).toEqual({
      state: "waiting",
    });
  });

  test("a delivered send wins over an earlier failed one", () => {
    const rows = [outbound({ id: 2, status: "failed", error: "bad" }), outbound({ id: 3, trail: [delivered(START + 3)] })];
    expect(sendToOutcome(rows, "34600111222", START).state).toBe("delivered");
  });
});

describe("path B: connect my tool", () => {
  test("waiting until a written message arrives; a status receipt is not one", () => {
    expect(forwardOutcome([], START)).toEqual({ state: "waiting" });
    expect(forwardOutcome([inbound({ type: "delivered" })], START)).toEqual({ state: "waiting" });
    expect(forwardOutcome([inbound()], START).state).toBe("arrived");
  });

  test("a 2xx forward (delivery delivered) is success, with who wrote and what", () => {
    const outcome = forwardOutcome([inbound({ delivery_status: "delivered", delivery_finished_at: START + 2_000 })], START);
    expect(outcome).toEqual({
      state: "accepted",
      at: START + 2_000,
      message: { from: "34600111222", text: "Hello, this is a test", at: START + 1_000 },
    });
  });

  test("a refusal carries the tool's HTTP status from the stored error", () => {
    const outcome = forwardOutcome([inbound({ delivery_attempts: 1, delivery_last_error: "subscriber returned 404" })], START);
    expect(outcome.state).toBe("refused");
    if (outcome.state === "refused") expect(outcome.httpStatus).toBe(404);
    const timeout = forwardOutcome([inbound({ delivery_last_error: "The operation timed out." })], START);
    if (timeout.state === "refused") expect(timeout.httpStatus).toBeNull();
  });

  test("events held from before the address was saved never count", () => {
    expect(forwardOutcome([inbound({ received_at: START - CLOCK_SLACK_MS - 1, delivery_status: "delivered" })], START)).toEqual({
      state: "waiting",
    });
  });
});

describe("activation seam", () => {
  const ready = (billingStatus: string, activation?: unknown) =>
    ({
      stage: "ready",
      canAdminister: true,
      role: "owner",
      status: {},
      scope: { accountId: "a", selectedWabaId: "100", resources: { account: { billingStatus }, keys: [], wabas: [], phones: [] } },
      billing: { subscribed: false, canManage: true, ...(activation === undefined ? {} : { activation }) },
    }) as unknown as DashboardState;
  const activation = { activatedAt: "2026-11-25T10:00:00Z", pausesAt: "2026-11-28T10:00:00Z" };

  test("the paywall is due when the workspace has activated without a subscription", () => {
    expect(pendingActivation(ready("setup", activation))).toEqual(activation);
    expect(pendingActivation(ready("active", activation))).toBeNull();
    expect(pendingActivation(ready("setup"))).toBeNull();
    expect(pendingActivation(ready("setup", null))).toBeNull();
  });

  test("hours left in the window, the full window when unknown", () => {
    expect(hoursLeft(null)).toBe(WINDOW_HOURS);
    expect(hoursLeft(activation, Date.parse("2026-11-25T10:30:00Z"))).toBe(72);
    expect(hoursLeft(activation, Date.parse("2026-11-29T00:00:00Z"))).toBe(0);
  });
});
