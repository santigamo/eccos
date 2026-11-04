import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parseMetaEchoes, parseMetaWebhook } from "@eccos/core/parser";
import { codeSpans, jsonFences, tableRows } from "./docs-md";

const doc = readFileSync(
  new URL("../../docs/src/content/docs/event-reference.md", import.meta.url),
  "utf8",
);
const typesSource = readFileSync(
  new URL("../../../packages/core/src/types.ts", import.meta.url),
  "utf8",
);
// Gateway-originated events are pinned by tests/worker/scheduled.spec.ts.
const examples = (jsonFences(doc) as Array<Record<string, any>>).filter((e) => e.type !== "scheduled_failed");

const sec = (ms: number) => String(ms / 1000);
const metadata = (ev: Record<string, any>) => ({
  phone_number_id: ev.phoneNumberId,
});
const envelope = (field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field, value }] }],
});
const inbound = (ev: Record<string, any>, message: Record<string, unknown>) =>
  parseMetaWebhook(
    envelope("messages", {
      metadata: metadata(ev),
      contacts: [{ wa_id: ev.from, profile: { name: ev.profileName } }],
      messages: [
        { from: ev.from, id: ev.messageId, timestamp: sec(ev.at), ...(ev.replyTo && { context: { from: "15550555555", id: ev.replyTo } }), ...message },
      ],
    }),
  );

/** For each documented event type, the Meta payload that real traffic would carry to produce it. */
const metaPayloadFor: Record<string, (ev: Record<string, any>) => unknown[]> = {
  delivered: (ev) =>
    parseMetaWebhook(
      envelope("messages", {
        metadata: metadata(ev),
        statuses: [
          {
            id: ev.transportMessageId,
            status: "delivered",
            timestamp: sec(ev.at),
            recipient_id: "34600000000",
          },
        ],
      }),
    ),
  failed: (ev) =>
    parseMetaWebhook(
      envelope("messages", {
        metadata: metadata(ev),
        statuses: [
          {
            id: ev.transportMessageId,
            status: "failed",
            timestamp: sec(ev.at),
            errors: [
              {
                code: Number(ev.errorCode),
                title: "a title the parser must not prefer",
                message: "ignored",
                error_data: { details: ev.errorMessage },
              },
            ],
          },
        ],
      }),
    ),
  reply: (ev) =>
    inbound(ev, {
      type: "button",
      button: { text: ev.text, payload: ev.payload },
    }),
  message: (ev) =>
    inbound(ev, {
      type: ev.messageType,
      [ev.messageType]: {
        id: ev.media.id,
        mime_type: ev.media.mimeType,
        sha256: ev.media.sha256,
        caption: ev.media.caption,
      },
    }),
  echo: (ev) =>
    parseMetaEchoes(
      envelope("smb_message_echoes", {
        metadata: metadata(ev),
        message_echoes: [
          {
            from: "15550555555",
            to: ev.to,
            id: ev.messageId,
            timestamp: sec(ev.at),
            type: "text",
            text: { body: ev.text },
          },
        ],
      }),
    ),
};

describe("event-reference.md JSON examples", () => {
  it("has the examples this test knows how to drive", () => {
    expect(examples.map((e) => e.type)).toEqual([
      "delivered",
      "failed",
      "reply",
      "message",
      "echo",
    ]);
  });

  for (const example of examples) {
    it(`the parser produces the documented ${example.type} event`, () => {
      const [event, ...rest] = metaPayloadFor[example.type]!(example);
      expect(rest).toHaveLength(0);
      expect(event).toEqual(example);
      expect(JSON.stringify(Object.keys(event as object).sort())).toBe(
        JSON.stringify(Object.keys(example).sort()),
      );
    });
  }
});

describe("event-reference.md `message` table", () => {
  const rows = tableRows(doc, "| `messageType`");
  const samples: Record<string, Record<string, unknown>> = {
    image: {
      type: "image",
      image: {
        id: "M",
        mime_type: "image/jpeg",
        sha256: "s",
        caption: "c",
        filename: "f.jpg",
      },
    },
    video: {
      type: "video",
      video: {
        id: "M",
        mime_type: "video/mp4",
        sha256: "s",
        caption: "c",
        filename: "f.mp4",
      },
    },
    audio: {
      type: "audio",
      audio: {
        id: "M",
        mime_type: "audio/ogg",
        sha256: "s",
        caption: "c",
        filename: "f.ogg",
      },
    },
    document: {
      type: "document",
      document: {
        id: "M",
        mime_type: "application/pdf",
        sha256: "s",
        caption: "c",
        filename: "f.pdf",
      },
    },
    sticker: {
      type: "sticker",
      sticker: {
        id: "M",
        mime_type: "image/webp",
        sha256: "s",
        caption: "c",
        filename: "f.webp",
      },
    },
    location: {
      type: "location",
      location: {
        latitude: 1,
        longitude: 2,
        name: "n",
        address: "a",
        url: "u",
      },
    },
    contacts: {
      type: "contacts",
      contacts: [{ name: { formatted_name: "Ada" } }],
    },
    reaction: {
      type: "reaction",
      reaction: { message_id: "wamid.O", emoji: "x" },
    },
    interactive: {
      type: "interactive",
      interactive: {
        type: "nfm_reply",
        nfm_reply: { body: "b", response_json: "{}" },
      },
    },
    order: { type: "order", order: { catalog_id: "C" } },
    system: {
      type: "system",
      system: { body: "b", type: "user_changed_number" },
    },
    edit: {
      type: "edit",
      edit: {
        original_message_id: "wamid.O",
        message: { type: "text", text: { body: "t" } },
      },
    },
    revoke: { type: "revoke", revoke: { original_message_id: "wamid.O" } },
    unsupported: {
      type: "unsupported",
      errors: [{ code: 131060, message: "m" }],
    },
  };

  const outputFor = (type: string) => {
    const [event] = parseMetaWebhook(
      envelope("messages", {
        messages: [
          {
            from: "34600000000",
            id: "wamid.X",
            timestamp: "1700000000",
            ...samples[type]!,
          },
        ],
      }),
    );
    return event as Record<string, any>;
  };

  it("lists every documented messageType with a sample", () => {
    const documented = rows.flatMap((r) => codeSpans(r[0]!));
    expect(documented.filter((t) => !(t in samples))).toEqual([]);
  });

  for (const row of rows) {
    for (const type of codeSpans(row[0]!)) {
      it(`${type}: documented extra fields are produced and declared in types.ts`, () => {
        const out = outputFor(type);
        expect(out.type).toBe("message");
        expect(out.messageType).toBe(type);
        const spans = codeSpans(row[1]!);
        for (const [i, span] of spans.entries()) {
          const [, key, nested] =
            span.match(/^(\w+)\??(?::\s*\{(.*)\})?$/) ?? [];
          const otherType = key !== type && codeSpans(row[0]!).includes(key);
          if (!key || otherType) continue;
          // Spans after the first are notes ("emoji is absent when..."); only declared-ness is checked.
          const produced = i === 0 || span.endsWith("?") || key === type;
          if (produced) expect(key in out, `${type}.${key}`).toBe(true);
          expect(typesSource).toMatch(new RegExp(`\\b${key}\\??:`));
          for (const inner of (nested ?? "")
            .split(",")
            .map((s) => s.trim().replace(/\?$/, ""))
            .filter(Boolean)) {
            expect(inner in out[key], `${type}.${key}.${inner}`).toBe(true);
            expect(typesSource).toMatch(new RegExp(`\\b${inner}\\??:`));
          }
        }
      });
    }
  }
});
