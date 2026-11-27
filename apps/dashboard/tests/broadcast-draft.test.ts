import { describe, expect, test } from "bun:test";
import type { DashboardStateResult } from "../src/server/gateway";
import {
  broadcastPayload,
  broadcastTemplates,
  type ComposeState,
  composeNote,
  fmtMinutes,
  MAX_BROADCAST_BYTES,
} from "../src/lib/broadcast-draft";
import { broadcastFailureCopy } from "../src/lib/broadcast-failure";
import type { ListTable } from "../src/lib/list-file";
import { checkList, type Mapping, slotsOf } from "../src/lib/recipient-list";
import { broadcastBlock } from "../src/lib/sends-paused";
import { validateCreateBroadcastInput } from "../src/server/broadcast-input";

const slots = slotsOf({
  format: "positional",
  body: [
    { key: "1", example: "Ana" },
    { key: "2", example: "Friday" },
  ],
  buttons: [{ index: 0, urlPrefix: "https://e.cc/o/" }],
  headerMedia: null,
});
const table: ListTable = {
  name: "list.csv",
  rows: [
    ["phone", "name", "order"],
    ["+34 600 111 222", "Ana", "T-1"],
    ["3.46E+10", "Marta", "T-2"],
  ],
  columns: 3,
};
const mapping: Mapping = {
  header: true,
  phone: 0,
  sources: { "body:1": { column: 1 }, "body:2": { fixed: " Friday " }, "button:0": { column: 2 } },
  fallback: {},
  country: "ES",
};

describe("broadcastPayload", () => {
  test("sends only the rows that will send, with a fixed column once for everyone", () => {
    const payload = broadcastPayload({
      wabaId: "W",
      phoneNumberId: "P",
      templateName: "order_ready",
      languageCode: "es",
      label: "  ",
      slots,
      mapping,
      check: checkList(table, mapping, slots),
      headerMedia: null,
    });
    expect(payload).toEqual({
      wabaId: "W",
      phoneNumberId: "P",
      templateName: "order_ready",
      languageCode: "es",
      columns: [
        { kind: "body", key: "1" },
        { kind: "body", key: "2", fixed: "Friday" },
        { kind: "button", index: 0 },
      ],
      recipients: [{ to: "34600111222", values: ["Ana", "T-1"] }],
    });
  });
});

describe("composeNote", () => {
  const ready: ComposeState = {
    blocked: null,
    hasTemplate: true,
    hasList: true,
    tooManyRows: null,
    phoneMapped: true,
    unmapped: null,
    headerMissing: null,
    sendable: 2431,
    total: 2440,
    bytes: 1000,
    pacePerMinute: 48,
  };

  test("says what the primary will do once nothing blocks it", () => {
    expect(composeNote(ready)).toEqual({ blocker: null, note: "2,431 of 2,440 rows will be sent, in about 51 min." });
  });

  test("names the first thing in the way, never disabled in silence", () => {
    expect(composeNote({ ...ready, hasTemplate: false, hasList: false }).blocker).toBe("Choose a template and add your list.");
    expect(composeNote({ ...ready, hasList: false }).blocker).toBe("Add your list to continue.");
    expect(composeNote({ ...ready, unmapped: slots[1] ?? null }).blocker).toBe("Choose a column for {{2}}.");
    expect(composeNote({ ...ready, headerMissing: "image" }).blocker).toBe("Add the link to the image for the header.");
    expect(composeNote({ ...ready, sendable: 0 }).blocker).toBe("No row in this list can be sent. Check the phone column.");
    expect(composeNote({ ...ready, bytes: MAX_BROADCAST_BYTES + 1 }).blocker).toContain("too large");
    expect(composeNote({ ...ready, blocked: "Sending is paused." }).blocker).toBe("Sending is paused.");
  });
});

test("fmtMinutes", () => {
  expect(fmtMinutes(51)).toBe("51 min");
  expect(fmtMinutes(120)).toBe("2 h");
  expect(fmtMinutes(192)).toBe("3 h 12 min");
});

test("broadcastTemplates lists the approved ones the console can build, and sets the rest apart", () => {
  const body = [{ type: "BODY", text: "Hi {{1}}" }];
  const { ready, unavailable, others } = broadcastTemplates([
    { name: "a", status: "APPROVED", components: body },
    { name: "b", status: "APPROVED", category: "AUTHENTICATION", components: body },
    { name: "c", status: "PENDING", components: body },
  ]);
  expect(ready.map((row) => row.name)).toEqual(["a"]);
  expect(unavailable.map(({ row }) => row.name)).toEqual(["b"]);
  expect(others).toBe(1);
});

test("each refusal has its own sentence and next step", () => {
  const context = { template: "order_ready (es)", sender: "+34 911 000 111" };
  expect(broadcastFailureCopy({ code: "template_not_approved", detail: null, templateStatus: "PAUSED" }, context)).toEqual({
    title: "order_ready (es) is no longer approved: Meta now lists it as PAUSED. Nothing was sent.",
    detail: null,
    actions: ["template", "edit"],
  });
  expect(broadcastFailureCopy({ code: "too_many_running", detail: null }, context).actions).toEqual(["broadcasts", "retry"]);
  expect(broadcastFailureCopy({ code: "no_phone", detail: null }, context).title).toContain("+34 911 000 111");
  expect(broadcastFailureCopy({ code: "invalid_recipients", detail: null, invalid: [{}, {}] }, context).title).toBe(
    "Eccos refused 2 rows of this list. Nothing was sent.",
  );
});

describe("broadcastBlock", () => {
  const root = (billingStatus: string, billing = true) =>
    ({
      ok: true,
      data: {
        stage: "account-ready",
        canAdminister: true,
        canOperate: true,
        role: "owner",
        resources: { account: { billingStatus }, keys: [], wabas: [{ wabaId: "W", phones: [] }], phones: [] },
        ...(billing ? { billing: { subscribed: false, canManage: true } } : {}),
      },
    }) as unknown as DashboardStateResult;

  test("sending paused, or the unpaid setup window, stops a console broadcast", () => {
    expect(broadcastBlock(root("paused"))).toBe("Sending is paused for this workspace, so a broadcast cannot start.");
    expect(broadcastBlock(root("setup"))).toBe("Broadcasts start from the console once this workspace is subscribed.");
    for (const status of ["active", "open", "past_due"]) expect(broadcastBlock(root(status))).toBeNull();
  });
});

describe("validateCreateBroadcastInput", () => {
  const input = {
    wabaId: "W",
    phoneNumberId: "P",
    templateName: "order_ready",
    languageCode: "es",
    label: " Friday ",
    columns: [{ kind: "body", key: "1" }],
    recipients: [{ to: "34600111222", values: ["Ana"] }],
    idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e",
  };

  test("passes a well-formed broadcast, label trimmed", () => {
    expect(validateCreateBroadcastInput(input)).toEqual({ ...input, label: "Friday" });
  });

  test("refuses what the gateway could never take", () => {
    for (const patch of [
      { recipients: [{ to: "+34 600", values: ["Ana"] }] },
      { recipients: [] },
      { idempotencyKey: "again" },
      { templateName: "Order Ready" },
      { columns: [{ kind: "header" }] },
      { label: "x".repeat(81) },
      { recipients: [{ to: "34600111222", values: ["x".repeat(1025)] }] },
    ]) {
      expect(() => validateCreateBroadcastInput({ ...input, ...patch })).toThrow();
    }
  });
});
