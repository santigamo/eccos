import type { MediaRef, MessageContent, WhatsAppCallbackEvent } from "./types";

export interface MetaWebhookBatch {
  wabaId: string;
  phoneNumberId: string | null;
  events: WhatsAppCallbackEvent[];
}

// ---------------------------------------------------------------------------
// Meta Cloud API native webhook shape:
//   { object: "whatsapp_business_account",
//     entry: [ { changes: [ { field: "messages",
//       value: { messaging_product, metadata, contacts, messages[], statuses[] } } ] } ] }
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Drops absent fields so an event never serializes `null` or `undefined`. */
function compact<T>(record: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value != null)) as T;
}

function metaError(value: unknown): { errorCode?: string; errorMessage?: string } {
  const firstError = Array.isArray(value) ? asRecord(value[0]) : null;
  const rawCode = firstError?.code;
  const errorCode =
    typeof rawCode === "string" && rawCode.trim() !== ""
      ? rawCode
      : typeof rawCode === "number" && Number.isFinite(rawCode)
        ? String(rawCode)
        : null;
  const errorMessage =
    getString(asRecord(firstError?.error_data)?.details) ??
    getString(firstError?.message) ??
    getString(firstError?.title);
  return compact({ errorCode, errorMessage });
}

function metaStatusToType(status: string): "delivered" | "read" | "failed" | null {
  if (status === "delivered") return "delivered";
  if (status === "read") return "read";
  if (status === "failed") return "failed";
  return null;
}

function parseMetaStatus(status: Record<string, unknown>): WhatsAppCallbackEvent | null {
  const statusName = getString(status.status);
  if (!statusName) return null;
  const type = metaStatusToType(statusName);
  if (!type) return null;

  const transportMessageId = getString(status.id);
  const at = parseTimestampMs(status.timestamp);
  if (!transportMessageId || !at) return null;

  if (type === "failed") {
    return { type: "failed", transportMessageId, at, ...metaError(status.errors) };
  }

  return { type, transportMessageId, at };
}

function metaMessageBody(message: Record<string, unknown>): string | null {
  const text = asRecord(message.text);
  const fromText = getString(text?.body);
  if (fromText) return fromText;

  const button = asRecord(message.button);
  const fromButton = getString(button?.text);
  if (fromButton) return fromButton;

  const interactive = asRecord(message.interactive);
  if (interactive) {
    const buttonReply = asRecord(interactive.button_reply);
    const fromButtonReply = getString(buttonReply?.title);
    if (fromButtonReply) return fromButtonReply;
    const listReply = asRecord(interactive.list_reply);
    const fromListReply = getString(listReply?.title);
    if (fromListReply) return fromListReply;
  }

  return null;
}

const MEDIA_TYPES = new Set(["image", "audio", "video", "document", "sticker"]);

function mediaRef(value: unknown): MediaRef | undefined {
  const media = asRecord(value);
  const id = getString(media?.id);
  if (!media || !id) return undefined;
  return compact({
    id,
    mimeType: getString(media.mime_type),
    sha256: getString(media.sha256),
    caption: getString(media.caption),
    filename: getString(media.filename),
  });
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The type-specific part of a Meta message, inbound or echo alike. */
function messageContent(message: Record<string, unknown>): MessageContent {
  const messageType = getString(message.type) ?? "unknown";
  const body = asRecord(message[messageType]);
  const content: Record<string, unknown> = { messageType, ...metaError(message.errors) };

  if (MEDIA_TYPES.has(messageType)) content.media = mediaRef(body);
  else if (messageType === "text") content.text = getString(body?.body);
  else if (messageType === "button") content.text = getString(body?.text);
  else if (messageType === "location") {
    const latitude = finiteNumber(body?.latitude);
    const longitude = finiteNumber(body?.longitude);
    if (latitude !== null && longitude !== null) {
      content.location = compact({
        latitude,
        longitude,
        name: getString(body?.name),
        address: getString(body?.address),
        url: getString(body?.url),
      });
    }
  } else if (messageType === "contacts") {
    if (Array.isArray(message.contacts)) content.contacts = message.contacts;
  } else if (messageType === "reaction") {
    const messageId = getString(body?.message_id);
    if (messageId) content.reaction = compact({ messageId, emoji: getString(body?.emoji) });
  } else if (messageType === "interactive") {
    const kind = getString(body?.type);
    const reply = kind ? asRecord(body?.[kind]) : null;
    if (kind) {
      content.interactive = compact({
        type: kind,
        body: getString(reply?.body) ?? getString(reply?.title),
        responseJson: getString(reply?.response_json),
      });
    }
  } else if (messageType === "order" || messageType === "system") {
    content[messageType] = body ?? undefined;
    if (messageType === "system") content.text = getString(body?.body);
  } else if (messageType === "edit") {
    const edited = asRecord(body?.message);
    if (edited) {
      const { messageType: _, ...editedContent } = messageContent(edited);
      Object.assign(content, editedContent);
    }
    content.originalMessageId = getString(body?.original_message_id);
  } else if (messageType === "revoke") {
    content.originalMessageId = getString(body?.original_message_id);
  }

  return compact(content);
}

function parseMetaMessage(message: Record<string, unknown>): WhatsAppCallbackEvent | null {
  const from = getString(message.from);
  const messageId = getString(message.id);
  const at = parseTimestampMs(message.timestamp);
  if (!from || !messageId || !at) return null;

  const text = metaMessageBody(message);
  if (text) return { type: "reply", from, messageId, text, at };
  return { type: "message", from, messageId, at, ...messageContent(message) };
}

function parseChangeValue(value: Record<string, unknown>): WhatsAppCallbackEvent[] {
  const events: WhatsAppCallbackEvent[] = [];

  const statuses = Array.isArray(value.statuses) ? value.statuses : [];
  for (const status of statuses) {
    const record = asRecord(status);
    if (!record) continue;
    const event = parseMetaStatus(record);
    if (event) events.push(event);
  }

  const messages = Array.isArray(value.messages) ? value.messages : [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) continue;
    const event = parseMetaMessage(record);
    if (event) events.push(event);
  }

  return events;
}

function phoneNumberId(value: Record<string, unknown>): string | null {
  return getString(asRecord(value.metadata)?.phone_number_id);
}

function addBatch(
  batches: Map<string, MetaWebhookBatch>,
  wabaId: string,
  phoneId: string | null,
  events: WhatsAppCallbackEvent[],
): void {
  if (events.length === 0) return;
  const annotated = phoneId
    ? events.map((event) => ({ ...event, phoneNumberId: phoneId }))
    : events;
  const key = `${wabaId}\u0000${phoneId ?? ""}`;
  const existing = batches.get(key);
  if (existing) {
    existing.events.push(...annotated);
    return;
  }
  batches.set(key, { wabaId, phoneNumberId: phoneId, events: annotated });
}

export function parseMetaWebhookBatches(payload: unknown): MetaWebhookBatch[] {
  const root = asRecord(payload);
  if (!root || root.object !== "whatsapp_business_account") return [];

  const entries = Array.isArray(root.entry) ? root.entry : [];
  const batches = new Map<string, MetaWebhookBatch>();

  for (const entry of entries) {
    const entryRecord = asRecord(entry);
    const wabaId = getString(entryRecord?.id);
    if (!wabaId) continue;
    const changes = Array.isArray(entryRecord?.changes) ? entryRecord.changes : [];
    for (const change of changes) {
      const changeRecord = asRecord(change);
      const field = changeRecord?.field;
      if (field !== undefined && field !== "messages") continue;
      const value = asRecord(changeRecord?.value);
      if (!value) continue;
      addBatch(batches, wabaId, phoneNumberId(value), parseChangeValue(value));
    }
  }

  return [...batches.values()];
}

export function parseMetaWebhook(payload: unknown): WhatsAppCallbackEvent[] {
  return parseMetaWebhookBatches(payload).flatMap((batch) => batch.events);
}

function parseEchoEntry(echo: Record<string, unknown>): WhatsAppCallbackEvent | null {
  const to = getString(echo.to);
  const messageId = getString(echo.id);
  const at = parseTimestampMs(echo.timestamp);
  if (!to || !messageId || !at) return null;

  const text = echo.type === "text" ? getString(asRecord(echo.text)?.body) : null;
  if (text) return { type: "echo", to, messageId, text, at };
  return { type: "message_echo", to, messageId, at, ...messageContent(echo) };
}

export function parseMetaEchoesBatches(payload: unknown): MetaWebhookBatch[] {
  const root = asRecord(payload);
  if (!root || root.object !== "whatsapp_business_account") return [];
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const batches = new Map<string, MetaWebhookBatch>();
  for (const entry of entries) {
    const entryRec = asRecord(entry);
    const wabaId = getString(entryRec?.id);
    if (!wabaId) continue;
    const changes = Array.isArray(entryRec?.changes) ? (entryRec?.changes as unknown[]) : [];
    for (const change of changes) {
      const cr = asRecord(change);
      if (cr?.field !== "smb_message_echoes") continue;
      const value = asRecord(cr?.value);
      if (!value) continue;
      const echoes = Array.isArray(value?.message_echoes) ? (value?.message_echoes as unknown[]) : [];
      const events: WhatsAppCallbackEvent[] = [];
      for (const e of echoes) {
        const rec = asRecord(e);
        if (!rec) continue;
        const ev = parseEchoEntry(rec);
        if (ev) events.push(ev);
      }
      addBatch(batches, wabaId, phoneNumberId(value), events);
    }
  }
  return [...batches.values()];
}

/** Parse smb_message_echoes changes: text as `echo`, everything else as `message_echo`. */
export function parseMetaEchoes(payload: unknown): WhatsAppCallbackEvent[] {
  return parseMetaEchoesBatches(payload).flatMap((batch) => batch.events);
}
