/** A Meta media object, referenced by id — Eccos never downloads it. */
export interface MediaRef {
  id: string;
  mimeType?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

/**
 * What a non-text message carries. Only the fields its `messageType` uses are
 * set; an unknown future type carries none of them and is still forwarded.
 * `contacts`, `order` and `system` are Meta's objects verbatim.
 */
export interface MessageContent {
  /** Meta's raw `type`: image, reaction, unsupported, edit, revoke, ... */
  messageType: string;
  text?: string;
  media?: MediaRef;
  location?: { latitude: number; longitude: number; name?: string; address?: string; url?: string };
  contacts?: unknown[];
  reaction?: { messageId: string; emoji?: string };
  interactive?: { type: string; body?: string; responseJson?: string };
  order?: Record<string, unknown>;
  system?: Record<string, unknown>;
  /** The message an `edit` or `revoke` acts on. */
  originalMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Normalized callback event. This is the contract Eccos forwards to subscribers,
 * intentionally kept compatible with downstream consumers so the gateway is a
 * drop-in relay in front of the Meta Cloud API.
 */
export type WhatsAppCallbackEvent =
  | {
      type: "delivered" | "read";
      transportMessageId: string;
      at: number;
      phoneNumberId?: string;
    }
  | {
      type: "failed";
      transportMessageId: string;
      at: number;
      errorCode?: string;
      errorMessage?: string;
      phoneNumberId?: string;
    }
  | {
      type: "reply";
      from: string;
      messageId: string;
      text: string;
      at: number;
      phoneNumberId?: string;
    }
  | {
      type: "echo";
      to: string;
      messageId: string;
      text: string;
      at: number;
      phoneNumberId?: string;
    }
  | ({
      type: "message";
      from: string;
      messageId: string;
      at: number;
      phoneNumberId?: string;
    } & MessageContent)
  | ({
      type: "message_echo";
      to: string;
      messageId: string;
      at: number;
      phoneNumberId?: string;
    } & MessageContent);
