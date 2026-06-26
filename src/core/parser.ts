import type { WhatsAppCallbackEvent } from "./types";

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
    const errors = Array.isArray(status.errors) ? status.errors : [];
    const firstError = errors.length > 0 ? asRecord(errors[0]) : null;
    const rawCode = firstError?.code;
    const errorCode =
      typeof rawCode === "string" && rawCode.trim() !== ""
        ? rawCode
        : typeof rawCode === "number" && Number.isFinite(rawCode)
          ? String(rawCode)
          : undefined;
    const errorData = asRecord(firstError?.error_data);
    const errorMessage =
      getString(errorData?.details) ??
      getString(firstError?.message) ??
      getString(firstError?.title) ??
      undefined;

    return {
      type: "failed",
      transportMessageId,
      at,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
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

function parseMetaMessage(message: Record<string, unknown>): WhatsAppCallbackEvent | null {
  const from = getString(message.from);
  const messageId = getString(message.id);
  const text = metaMessageBody(message);
  const at = parseTimestampMs(message.timestamp);
  if (!from || !messageId || !text || !at) return null;

  return { type: "reply", from, messageId, text, at };
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

export function parseMetaWebhook(payload: unknown): WhatsAppCallbackEvent[] {
  const root = asRecord(payload);
  if (!root || root.object !== "whatsapp_business_account") return [];

  const entries = Array.isArray(root.entry) ? root.entry : [];
  const events: WhatsAppCallbackEvent[] = [];

  for (const entry of entries) {
    const entryRecord = asRecord(entry);
    const changes = Array.isArray(entryRecord?.changes) ? entryRecord.changes : [];
    for (const change of changes) {
      const changeRecord = asRecord(change);
      const field = changeRecord?.field;
      if (field !== undefined && field !== "messages") continue;
      const value = asRecord(changeRecord?.value);
      if (!value) continue;
      events.push(...parseChangeValue(value));
    }
  }

  return events;
}

function parseEchoEntry(echo: Record<string, unknown>): WhatsAppCallbackEvent | null {
  if (echo.type !== "text") return null;
  const to = getString(echo.to);
  const messageId = getString(echo.id);
  const text = getString(asRecord(echo.text)?.body);
  const at = parseTimestampMs(echo.timestamp);
  if (!to || !messageId || !text || !at) return null;
  return { type: "echo", to, messageId, text, at };
}

/** Parse smb_message_echoes changes into echo events (text only in v1). */
export function parseMetaEchoes(payload: unknown): WhatsAppCallbackEvent[] {
  const root = asRecord(payload);
  if (!root || root.object !== "whatsapp_business_account") return [];
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const events: WhatsAppCallbackEvent[] = [];
  for (const entry of entries) {
    const changes = Array.isArray(asRecord(entry)?.changes) ? (asRecord(entry)!.changes as unknown[]) : [];
    for (const change of changes) {
      const cr = asRecord(change);
      if (cr?.field !== "smb_message_echoes") continue;
      const value = asRecord(cr?.value);
      const echoes = Array.isArray(value?.message_echoes) ? (value!.message_echoes as unknown[]) : [];
      for (const e of echoes) {
        const rec = asRecord(e);
        if (!rec) continue;
        const ev = parseEchoEntry(rec);
        if (ev) events.push(ev);
      }
    }
  }
  return events;
}
