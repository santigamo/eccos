import { describe, expect, test } from "bun:test";
import type { CreateBroadcastInput } from "@eccos/gateway-contract";
import { broadcastBody } from "../src/broadcast-columns";
import { parseBroadcastRequest } from "../src/broadcasts";

const positional = {
  parameter_format: "POSITIONAL",
  components: [
    { type: "BODY", text: "Hi {{1}}, pick it up on {{2}}." },
    { type: "BUTTONS", buttons: [{ type: "URL", url: "https://e.cc/o/{{1}}" }, { type: "QUICK_REPLY", text: "Stop" }] },
  ],
};

const named = {
  parameter_format: "NAMED",
  components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{customer_name}}" }],
};

const input = (patch: Partial<CreateBroadcastInput> = {}): CreateBroadcastInput => ({
  wabaId: "W",
  phoneNumberId: "P",
  templateName: "order_ready",
  languageCode: "es",
  columns: [
    { kind: "body", key: "2" },
    { kind: "body", key: "1" },
    { kind: "button", index: 0, fixed: "T-1" },
  ],
  recipients: [
    { to: "34600111222", values: ["Friday", "Ana"] },
    { to: "34600333444", values: ["Saturday", "Luis"] },
  ],
  idempotencyKey: "k",
  ...patch,
});

describe("broadcastBody", () => {
  test("builds each recipient's components in the template's order, whatever the column order", () => {
    const built = broadcastBody(input({ label: "Friday pickups" }), positional);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.label).toBe("Friday pickups");
    const parsed = parseBroadcastRequest(built.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.label).toBe("Friday pickups");
    expect(parsed.request.recipients[0]).toEqual({
      to: "34600111222",
      components: [
        { type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "Friday" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "T-1" }] },
      ],
    });
  });

  test("sends NAMED values by name, with the header link for everyone", () => {
    const built = broadcastBody(
      input({
        columns: [{ kind: "body", key: "customer_name" }],
        headerMedia: { format: "image", link: "https://e.cc/a.png" },
        recipients: [{ to: "34600111222", values: ["Ana"] }],
      }),
      named,
    );
    expect(built.ok && (built.body.recipients as { components: unknown }[])[0]?.components).toEqual([
      { type: "header", parameters: [{ type: "image", image: { link: "https://e.cc/a.png" } }] },
      { type: "body", parameters: [{ type: "text", parameter_name: "customer_name", text: "Ana" }] },
    ]);
  });

  test("one set of components for everyone when no column varies per row", () => {
    const built = broadcastBody(
      input({ columns: [{ kind: "body", key: "customer_name", fixed: "friend" }], headerMedia: { format: "image", link: "https://e.cc/a.png" }, recipients: [{ to: "34600111222", values: [] }] }),
      named,
    );
    expect(built.ok && built.body).toMatchObject({ template: { components: [{ type: "header" }, { type: "body" }] }, recipients: [{ to: "34600111222" }] });
  });

  test("refuses columns that are not exactly the template's variables", () => {
    for (const columns of [
      [{ kind: "body", key: "1" }],
      [{ kind: "body", key: "1" }, { kind: "body", key: "1" }, { kind: "button", index: 0 }],
      [{ kind: "body", key: "1" }, { kind: "body", key: "2" }],
    ] as CreateBroadcastInput["columns"][]) {
      expect(broadcastBody(input({ columns }), positional)).toMatchObject({ ok: false, code: "parameter_mismatch" });
    }
    expect(broadcastBody(input({ columns: [{ kind: "body", key: "customer_name" }] }), named)).toMatchObject({
      code: "parameter_mismatch",
    });
  });

  test("names the rows whose values cannot be sent", () => {
    const built = broadcastBody(
      input({
        recipients: [
          { to: "34600111222", values: ["Friday", "Ana"] },
          { to: "34600333444", values: ["Friday", ""] },
          { to: "34600555666", values: ["Friday"] },
          { to: "34600777888", values: ["Fri\nday", "Eva"] },
        ],
      }),
      positional,
    );
    expect(built).toMatchObject({ ok: false, code: "invalid_recipients", invalid: [{ index: 1 }, { index: 2 }, { index: 3 }] });
  });

  test("a template the console cannot build is unsupported", () => {
    expect(broadcastBody(input(), { category: "AUTHENTICATION" })).toMatchObject({ code: "template_unsupported" });
  });

  test("an http header link is an invalid request", () => {
    const built = broadcastBody(
      input({ columns: [{ kind: "body", key: "customer_name" }], headerMedia: { format: "image", link: "http://e.cc/a.png" }, recipients: [] }),
      named,
    );
    expect(built).toMatchObject({ ok: false, code: "invalid_request" });
  });
});
