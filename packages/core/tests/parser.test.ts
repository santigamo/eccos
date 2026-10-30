import { describe, it, expect } from "bun:test";
import {
  parseMetaEchoes,
  parseMetaEchoesBatches,
  parseMetaWebhook,
  parseMetaWebhookBatches,
} from "@eccos/core/parser";

const TS_SEC = "1700000000";
const TS_MS = 1_700_000_000_000;

function envelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_ID", changes: [{ field: "messages", value }] }],
  };
}

describe("parseMetaWebhook", () => {
  it("groups events by WABA and phone number and annotates events with the phone", () => {
    const batches = parseMetaWebhookBatches({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_A",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PHONE_A" },
                messages: [{ from: "34600000000", id: "wamid.A", timestamp: TS_SEC, type: "text", text: { body: "A" } }],
              },
            },
          ],
        },
        {
          id: "WABA_B",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PHONE_B" },
                statuses: [{ id: "wamid.B", status: "delivered", timestamp: TS_SEC }],
              },
            },
          ],
        },
      ],
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ wabaId: "WABA_A", phoneNumberId: "PHONE_A" });
    expect(batches[0]?.events[0]).toMatchObject({ type: "reply", messageId: "wamid.A", phoneNumberId: "PHONE_A" });
    expect(batches[1]).toMatchObject({ wabaId: "WABA_B", phoneNumberId: "PHONE_B" });
    expect(batches[1]?.events[0]).toMatchObject({ type: "delivered", transportMessageId: "wamid.B", phoneNumberId: "PHONE_B" });
  });

  it("parses a sent status", () => {
    const events = parseMetaWebhook(envelope({ statuses: [{ id: "wamid.S", status: "sent", timestamp: TS_SEC }] }));
    expect(events).toEqual([{ type: "sent", transportMessageId: "wamid.S", at: TS_MS }]);
  });

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

  it("parses a played voice-message status, sent with BSUID contacts, as read", () => {
    const events = parseMetaWebhook(
      envelope({
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "15550000000", phone_number_id: "PHONE_ID" },
        contacts: [{ profile: { name: "Ana" }, wa_id: "34600000000", user_id: "US.1234567890" }],
        statuses: [
          {
            id: "wamid.P",
            status: "played",
            timestamp: TS_SEC,
            recipient_id: "34600000000",
            recipient_user_id: "US.1234567890",
          },
        ],
      }),
    );
    expect(events).toEqual([{ type: "read", transportMessageId: "wamid.P", at: TS_MS, phoneNumberId: "PHONE_ID" }]);
  });

  it("parses a status sent to a BSUID, without recipient_id", () => {
    const events = parseMetaWebhook(
      envelope({
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "15550000000", phone_number_id: "PHONE_ID" },
        contacts: [{ profile: { name: "Ana", username: "ana" }, user_id: "US.1234567890" }],
        statuses: [
          {
            id: "wamid.U",
            status: "delivered",
            timestamp: TS_SEC,
            recipient_user_id: "US.1234567890",
            pricing: { billable: false, pricing_model: "PMP", category: "service", type: "free_customer_service" },
          },
        ],
      }),
    );
    expect(events).toEqual([
      { type: "delivered", transportMessageId: "wamid.U", at: TS_MS, phoneNumberId: "PHONE_ID" },
    ]);
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

  it("serializes reply and echo byte-for-byte as the forwarding contract", () => {
    const [reply] = parseMetaWebhook(
      envelope({
        metadata: { phone_number_id: "PHONE_ID" },
        messages: [{ from: "34600000000", id: "wamid.M", timestamp: TS_SEC, type: "text", text: { body: "Hola" } }],
      }),
    );
    expect(JSON.stringify(reply)).toBe(
      '{"type":"reply","from":"34600000000","messageId":"wamid.M","text":"Hola","at":1700000000000,"phoneNumberId":"PHONE_ID"}',
    );
    const [echoed] = parseMetaEchoes({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                metadata: { phone_number_id: "PHONE_ID" },
                message_echoes: [
                  { to: "16505551234", id: "wamid.E", timestamp: TS_SEC, type: "text", text: { body: "Hi" } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(echoed)).toBe(
      '{"type":"echo","to":"16505551234","messageId":"wamid.E","text":"Hi","at":1700000000000,"phoneNumberId":"PHONE_ID"}',
    );
  });

  it("drops a text with an empty body and a button or reply with an empty title", () => {
    const from = { from: "34600000000", id: "wamid.M", timestamp: TS_SEC };
    const messages = [
      { ...from, type: "text", text: { body: "   " } },
      { ...from, type: "button", button: { text: "", payload: "P" } },
      { ...from, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b", title: "" } } },
      { ...from, type: "interactive", interactive: { type: "list_reply", list_reply: { id: "l", title: " " } } },
    ];
    expect(parseMetaWebhook(envelope({ messages }))).toHaveLength(0);
  });

  it("parses a quick-reply button and an interactive button_reply", () => {
    const button = parseMetaWebhook(
      envelope({
        messages: [
          { from: "34600000000", id: "b", timestamp: TS_SEC, type: "button", button: { text: "Confirmar visita", payload: "confirm_42" } },
        ],
      }),
    );
    expect(button[0]).toMatchObject({ type: "reply", text: "Confirmar visita", payload: "confirm_42" });

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
    expect(interactive[0]).toMatchObject({ type: "reply", text: "Cancelar visita", payload: "x" });

    const list = parseMetaWebhook(
      envelope({
        messages: [
          {
            from: "34600000000",
            id: "l",
            timestamp: TS_SEC,
            type: "interactive",
            interactive: { type: "list_reply", list_reply: { id: "row_1", title: "Lunes" } },
          },
        ],
      }),
    );
    expect(list[0]).toMatchObject({ type: "reply", text: "Lunes", payload: "row_1" });
  });

  it("omits payload when a reply carries none", () => {
    const events = parseMetaWebhook(
      envelope({
        messages: [{ from: "34600000000", id: "b", timestamp: TS_SEC, type: "button", button: { text: "Hola" } }],
      }),
    );
    expect(events[0]).not.toHaveProperty("payload");
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
  it("preserves WABA and phone metadata for echo routing", () => {
    const batches = parseMetaEchoesBatches(ECHO_PAYLOAD);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ wabaId: "WABA_ID", phoneNumberId: "PHONE_NUMBER_ID" });
  });

  it("parses a text echo from smb_message_echoes", () => {
    const events = parseMetaEchoes(ECHO_PAYLOAD);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "echo",
      to: "16505551234",
      messageId: "wamid.HBgN16505551234",
      text: "Here's the info you requested.",
      at: 1_520_383_574_000,
      phoneNumberId: "PHONE_NUMBER_ID",
    });
  });

  it("forwards an image echo as message_echo instead of dropping it", () => {
    const events = parseMetaEchoes(echoEnvelope({ type: "image", image: { id: "media-id" } }));
    expect(events).toEqual([
      { type: "message_echo", to: "16505551234", messageId: "wamid.E", at: 1_520_383_574_000, messageType: "image", media: { id: "media-id" } },
    ]);
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

function inbound(message: Record<string, unknown>) {
  const events = parseMetaWebhook(
    envelope({ messages: [{ from: "34600000000", id: "wamid.N", timestamp: TS_SEC, ...message }] }),
  );
  expect(events).toHaveLength(1);
  return events[0];
}

function echoEnvelope(echo: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "smb_message_echoes",
            value: { message_echoes: [{ to: "16505551234", id: "wamid.E", timestamp: "1520383574", ...echo }] },
          },
        ],
      },
    ],
  };
}

function echo(message: Record<string, unknown>) {
  const events = parseMetaEchoes(echoEnvelope(message));
  expect(events).toHaveLength(1);
  return events[0];
}

const IMAGE = {
  id: "MEDIA_1",
  mime_type: "image/jpeg",
  sha256: "abc123",
  caption: "Receipt",
  url: "https://lookaside.example/ignored",
};
const MEDIA_REF = { id: "MEDIA_1", mimeType: "image/jpeg", sha256: "abc123", caption: "Receipt" };

describe("non-text inbound messages", () => {
  it("parses media into one media reference, never the download url", () => {
    expect(inbound({ type: "image", image: IMAGE })).toEqual({
      type: "message",
      from: "34600000000",
      messageId: "wamid.N",
      at: TS_MS,
      messageType: "image",
      media: MEDIA_REF,
    });
    for (const type of ["audio", "video", "sticker"]) {
      expect(inbound({ type, [type]: { id: "M", mime_type: "x/y" } })).toMatchObject({
        type: "message",
        messageType: type,
        media: { id: "M", mimeType: "x/y" },
      });
    }
    expect(
      inbound({ type: "document", document: { id: "D", filename: "cita.pdf", mime_type: "application/pdf" } }),
    ).toMatchObject({ messageType: "document", media: { id: "D", filename: "cita.pdf", mimeType: "application/pdf" } });
  });

  it("parses a location", () => {
    expect(
      inbound({ type: "location", location: { latitude: 40.4, longitude: -3.7, name: "Office", address: "Main St 1" } }),
    ).toMatchObject({
      type: "message",
      messageType: "location",
      location: { latitude: 40.4, longitude: -3.7, name: "Office", address: "Main St 1" },
    });
  });

  it("parses a reaction and a removed reaction", () => {
    expect(inbound({ type: "reaction", reaction: { message_id: "wamid.ORIG", emoji: "👍" } })).toMatchObject({
      messageType: "reaction",
      reaction: { messageId: "wamid.ORIG", emoji: "👍" },
    });
    expect(inbound({ type: "reaction", reaction: { message_id: "wamid.ORIG", emoji: "" } })).toMatchObject({
      reaction: { messageId: "wamid.ORIG" },
    });
  });

  it("passes contact cards, orders and system messages through verbatim", () => {
    const contacts = [{ name: { formatted_name: "Ada" }, phones: [{ phone: "+34600000001" }] }];
    expect(inbound({ type: "contacts", contacts })).toMatchObject({ messageType: "contacts", contacts });
    const order = { catalog_id: "C", product_items: [{ product_retailer_id: "P", quantity: 1 }] };
    expect(inbound({ type: "order", order })).toMatchObject({ messageType: "order", order });
    const system = { body: "User changed number", type: "user_changed_number", wa_id: "34600000002" };
    expect(inbound({ type: "system", system })).toMatchObject({ messageType: "system", system, text: system.body });
  });

  it("parses a flow (nfm_reply) response", () => {
    expect(
      inbound({
        type: "interactive",
        interactive: { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: '{"a":1}' } },
      }),
    ).toMatchObject({
      type: "message",
      messageType: "interactive",
      interactive: { type: "nfm_reply", body: "Sent", responseJson: '{"a":1}' },
    });
  });

  it("surfaces an unsupported message with Meta's error code instead of dropping it", () => {
    expect(
      inbound({
        type: "unsupported",
        errors: [{ code: 131060, title: "Content unavailable", message: "Content unavailable" }],
      }),
    ).toEqual({
      type: "message",
      from: "34600000000",
      messageId: "wamid.N",
      at: TS_MS,
      messageType: "unsupported",
      errorCode: "131060",
      errorMessage: "Content unavailable",
    });
  });

  it("degrades an unknown future type to a generic message", () => {
    expect(inbound({ type: "hologram", hologram: { id: "H" } })).toEqual({
      type: "message",
      from: "34600000000",
      messageId: "wamid.N",
      at: TS_MS,
      messageType: "hologram",
    });
  });

  it("still drops messages without sender, id or timestamp", () => {
    expect(parseMetaWebhook(envelope({ messages: [{ id: "x", timestamp: TS_SEC, type: "image" }] }))).toHaveLength(0);
  });
});

describe("non-text echoes", () => {
  it("uses the same media reference as inbound", () => {
    expect(echo({ type: "image", image: IMAGE })).toEqual({
      type: "message_echo",
      to: "16505551234",
      messageId: "wamid.E",
      at: 1_520_383_574_000,
      messageType: "image",
      media: MEDIA_REF,
    });
    expect(echo({ type: "document", document: { id: "D", filename: "f.pdf" } })).toMatchObject({
      messageType: "document",
      media: { id: "D", filename: "f.pdf" },
    });
    expect(echo({ type: "audio", audio: { id: "A" } })).toMatchObject({ messageType: "audio", media: { id: "A" } });
    expect(echo({ type: "video", video: { id: "V", caption: "Clip" } })).toMatchObject({
      messageType: "video",
      media: { id: "V", caption: "Clip" },
    });
  });

  it("parses location and reaction echoes", () => {
    expect(echo({ type: "location", location: { latitude: "40.4", longitude: "-3.7" } })).toMatchObject({
      messageType: "location",
      location: { latitude: 40.4, longitude: -3.7 },
    });
    expect(echo({ type: "reaction", reaction: { message_id: "wamid.C", emoji: "❤️" } })).toMatchObject({
      messageType: "reaction",
      reaction: { messageId: "wamid.C", emoji: "❤️" },
    });
  });

  it("parses an edit with its new content and the original message id", () => {
    expect(
      echo({
        type: "edit",
        edit: { original_message_id: "wamid.ORIG", message: { type: "text", text: { body: "Fixed typo" } } },
      }),
    ).toEqual({
      type: "message_echo",
      to: "16505551234",
      messageId: "wamid.E",
      at: 1_520_383_574_000,
      messageType: "edit",
      text: "Fixed typo",
      originalMessageId: "wamid.ORIG",
    });
    expect(
      echo({ type: "edit", edit: { original_message_id: "wamid.ORIG", message: { type: "image", image: IMAGE } } }),
    ).toMatchObject({ messageType: "edit", media: MEDIA_REF, originalMessageId: "wamid.ORIG" });
  });

  it("parses an edit whose new content is empty as just the original message id", () => {
    expect(
      echo({ type: "edit", edit: { original_message_id: "wamid.ORIG", message: { type: "text", text: { body: "" } } } }),
    ).toEqual({
      type: "message_echo",
      to: "16505551234",
      messageId: "wamid.E",
      at: 1_520_383_574_000,
      messageType: "edit",
      originalMessageId: "wamid.ORIG",
    });
  });

  it("drops a text echo with an empty body and a button echo with an empty title", () => {
    for (const empty of [
      { type: "text", text: { body: " " } },
      { type: "button", button: { text: "" } },
    ]) {
      expect(parseMetaEchoes(echoEnvelope(empty))).toHaveLength(0);
    }
  });

  it("parses a revoke", () => {
    expect(echo({ type: "revoke", revoke: { original_message_id: "wamid.ORIG" } })).toEqual({
      type: "message_echo",
      to: "16505551234",
      messageId: "wamid.E",
      at: 1_520_383_574_000,
      messageType: "revoke",
      originalMessageId: "wamid.ORIG",
    });
  });

  it("surfaces unsupported and unknown echo types", () => {
    expect(echo({ type: "unsupported", errors: [{ code: 131060, title: "Content unavailable" }] })).toMatchObject({
      type: "message_echo",
      messageType: "unsupported",
      errorCode: "131060",
      errorMessage: "Content unavailable",
    });
    expect(echo({ type: "hologram" })).toEqual({
      type: "message_echo",
      to: "16505551234",
      messageId: "wamid.E",
      at: 1_520_383_574_000,
      messageType: "hologram",
    });
  });
});

describe("profile names", () => {
  const contacts = [{ profile: { name: "Ana" }, wa_id: "34600000000" }];
  const text = { from: "34600000000", id: "wamid.P1", timestamp: TS_SEC, type: "text", text: { body: "Hola" } };

  it("carries the sender's profile name on a reply, keyed by wa_id", () => {
    const [reply] = parseMetaWebhook(envelope({ contacts, messages: [text] }));
    expect(reply).toEqual({ type: "reply", from: "34600000000", messageId: "wamid.P1", text: "Hola", at: TS_MS, profileName: "Ana" });
  });

  it("carries it on a non-text message too", () => {
    const [image] = parseMetaWebhook(
      envelope({
        contacts,
        messages: [{ from: "34600000000", id: "wamid.P2", timestamp: TS_SEC, type: "image", image: { id: "MEDIA_1" } }],
      }),
    );
    expect(image).toMatchObject({ type: "message", messageType: "image", profileName: "Ana" });
  });

  it("names only the sender: another contact in the same change does not leak in", () => {
    const [reply] = parseMetaWebhook(
      envelope({ contacts: [...contacts, { profile: { name: "Luis" }, wa_id: "34600000009" }], messages: [text] }),
    );
    expect(reply).toMatchObject({ profileName: "Ana" });
  });

  it("leaves profileName out when Meta gives none, so the serialized event is unchanged", () => {
    const [noName] = parseMetaWebhook(envelope({ contacts: [{ wa_id: "34600000000" }], messages: [text] }));
    expect(JSON.stringify(noName)).toBe(
      '{"type":"reply","from":"34600000000","messageId":"wamid.P1","text":"Hola","at":1700000000000}',
    );
    const [blank] = parseMetaWebhook(envelope({ contacts: [{ profile: { name: " " }, wa_id: "34600000000" }], messages: [text] }));
    expect(blank).not.toHaveProperty("profileName");
  });

  it("never puts a profile name on an echo, which has no sender profile", () => {
    const [echo] = parseMetaEchoes({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                contacts,
                message_echoes: [{ to: "34600000000", id: "wamid.E1", timestamp: TS_SEC, type: "text", text: { body: "Hola" } }],
              },
            },
          ],
        },
      ],
    });
    expect(echo).not.toHaveProperty("profileName");
  });
});
