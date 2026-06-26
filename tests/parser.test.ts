import { describe, it, expect } from "bun:test";
import { parseMetaWebhook, parseMetaEchoes } from "../src/core/parser";

const TS_SEC = "1700000000";
const TS_MS = 1_700_000_000_000;

function envelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_ID", changes: [{ field: "messages", value }] }],
  };
}

describe("parseMetaWebhook", () => {
  it("parses a delivered status", () => {
    const events = parseMetaWebhook(
      envelope({ statuses: [{ id: "wamid.D", status: "delivered", timestamp: TS_SEC }] }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "delivered", transportMessageId: "wamid.D", at: TS_MS });
  });

  it("parses a read status", () => {
    const events = parseMetaWebhook(
      envelope({ statuses: [{ id: "wamid.R", status: "read", timestamp: TS_SEC }] }),
    );
    expect(events[0]).toEqual({ type: "read", transportMessageId: "wamid.R", at: TS_MS });
  });

  it("parses a failed status, preferring error_data.details", () => {
    const events = parseMetaWebhook(
      envelope({
        statuses: [
          {
            id: "wamid.F",
            status: "failed",
            timestamp: TS_SEC,
            errors: [
              {
                code: 131047,
                title: "Re-engagement message",
                message: "Message failed to send",
                error_data: { details: "More than 24 hours have passed..." },
              },
            ],
          },
        ],
      }),
    );
    expect(events[0]).toEqual({
      type: "failed",
      transportMessageId: "wamid.F",
      at: TS_MS,
      errorCode: "131047",
      errorMessage: "More than 24 hours have passed...",
    });
  });

  it("drops a sent status", () => {
    const events = parseMetaWebhook(
      envelope({ statuses: [{ id: "wamid.S", status: "sent", timestamp: TS_SEC }] }),
    );
    expect(events).toHaveLength(0);
  });

  it("parses an inbound text message", () => {
    const events = parseMetaWebhook(
      envelope({
        messages: [
          { from: "34600000000", id: "wamid.M", timestamp: TS_SEC, type: "text", text: { body: "Hola" } },
        ],
      }),
    );
    expect(events[0]).toEqual({
      type: "reply",
      from: "34600000000",
      messageId: "wamid.M",
      text: "Hola",
      at: TS_MS,
    });
  });

  it("parses a quick-reply button and an interactive button_reply", () => {
    const button = parseMetaWebhook(
      envelope({
        messages: [
          { from: "34600000000", id: "b", timestamp: TS_SEC, type: "button", button: { text: "Confirmar visita" } },
        ],
      }),
    );
    expect(button[0]).toMatchObject({ type: "reply", text: "Confirmar visita" });

    const interactive = parseMetaWebhook(
      envelope({
        messages: [
          {
            from: "34600000000",
            id: "i",
            timestamp: TS_SEC,
            type: "interactive",
            interactive: { type: "button_reply", button_reply: { id: "x", title: "Cancelar visita" } },
          },
        ],
      }),
    );
    expect(interactive[0]).toMatchObject({ type: "reply", text: "Cancelar visita" });
  });

  it("emits both statuses and messages from one change", () => {
    const events = parseMetaWebhook(
      envelope({
        statuses: [{ id: "wamid.D", status: "delivered", timestamp: TS_SEC }],
        messages: [
          { from: "34600000000", id: "wamid.M", timestamp: TS_SEC, type: "text", text: { body: "Gracias" } },
        ],
      }),
    );
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.type === "delivered")).toBeDefined();
    expect(events.find((e) => e.type === "reply")).toBeDefined();
  });

  it("skips non-messages fields and foreign objects", () => {
    expect(
      parseMetaWebhook({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_ID",
            changes: [{ field: "message_template_status_update", value: { event: "APPROVED" } }],
          },
        ],
      }),
    ).toHaveLength(0);

    expect(parseMetaWebhook({ object: "page", entry: [] })).toHaveLength(0);
    expect(parseMetaWebhook(null)).toHaveLength(0);
  });
});

/** Payload shape from meta-es-coexistence.md §5.1 (reference echo webhook). */
const ECHO_PAYLOAD = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "smb_message_echoes",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550555555",
              phone_number_id: "PHONE_NUMBER_ID",
            },
            message_echoes: [
              {
                from: "15550555555",
                to: "16505551234",
                id: "wamid.HBgN16505551234",
                timestamp: "1520383574",
                type: "text",
                text: { body: "Here's the info you requested." },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe("parseMetaEchoes", () => {
  it("parses a text echo from smb_message_echoes", () => {
    const events = parseMetaEchoes(ECHO_PAYLOAD);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "echo",
      to: "16505551234",
      messageId: "wamid.HBgN16505551234",
      text: "Here's the info you requested.",
      at: 1_520_383_574_000,
    });
  });

  it("drops image echoes (D6)", () => {
    const events = parseMetaEchoes({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                message_echoes: [
                  {
                    to: "16505551234",
                    id: "wamid.IMG",
                    timestamp: "1520383574",
                    type: "image",
                    image: { id: "media-id" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(0);
  });

  it("drops echoes missing required fields", () => {
    expect(
      parseMetaEchoes({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "smb_message_echoes",
                value: {
                  message_echoes: [{ type: "text", id: "wamid.X", timestamp: "1520383574", text: { body: "hi" } }],
                },
              },
            ],
          },
        ],
      }),
    ).toHaveLength(0);
  });

  it("does not parse echoes via parseMetaWebhook", () => {
    expect(parseMetaWebhook(ECHO_PAYLOAD)).toHaveLength(0);
  });
});
