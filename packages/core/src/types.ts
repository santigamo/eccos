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

/** Where Eccos sent the message an event is about: a status's message, or the message `replyTo` names. Absent for messages sent any other way. */
export interface EventOrigin {
  /** The broadcast that sent it. */
  broadcastId?: string;
  /** The key of the scheduled send that sent it. */
  scheduleKey?: string;
}

/**
 * Normalized callback event. This is the contract Eccos forwards to subscribers,
 * intentionally kept compatible with downstream consumers so the gateway is a
 * drop-in relay in front of the Meta Cloud API.
 */
export type WhatsAppCallbackEvent =
  | ({
      type: "sent" | "delivered" | "read";
      transportMessageId: string;
      at: number;
      phoneNumberId?: string;
    } & EventOrigin)
  | ({
      type: "failed";
      transportMessageId: string;
      at: number;
      errorCode?: string;
      errorMessage?: string;
      phoneNumberId?: string;
    } & EventOrigin)
  | ({
      type: "reply";
      /** The sender's phone number, or their BSUID when Meta withholds the number. */
      from: string;
      /** The sender's business-scoped user id (BSUID), when Meta sends one. */
      fromUserId?: string;
      messageId: string;
      text: string;
      at: number;
      phoneNumberId?: string;
      /** The sender's WhatsApp profile name, when Meta sends one. */
      profileName?: string;
      /** A quick-reply button's `payload`, or a button/list reply's `id`. */
      payload?: string;
      /** The id (wamid) of the message this one replies to: a quoted message, the template or interactive message whose button was tapped, or the Flow message answered. */
      replyTo?: string;
    } & EventOrigin)
  | {
      type: "echo";
      /** The recipient's phone number, or their BSUID when Meta withholds the number. */
      to: string;
      /** The recipient's business-scoped user id (BSUID), when Meta sends one. */
      toUserId?: string;
      messageId: string;
      text: string;
      at: number;
      phoneNumberId?: string;
    }
  | ({
      type: "message";
      /** The sender's phone number, or their BSUID when Meta withholds the number. */
      from: string;
      /** The sender's business-scoped user id (BSUID), when Meta sends one. */
      fromUserId?: string;
      messageId: string;
      at: number;
      phoneNumberId?: string;
      /** The sender's WhatsApp profile name, when Meta sends one. */
      profileName?: string;
      /** The id (wamid) of the message this one replies to: a quoted message, the template or interactive message whose button was tapped, or the Flow message answered. */
      replyTo?: string;
    } & MessageContent & EventOrigin)
  | ({
      type: "message_echo";
      /** The recipient's phone number, or their BSUID when Meta withholds the number. */
      to: string;
      /** The recipient's business-scoped user id (BSUID), when Meta sends one. */
      toUserId?: string;
      messageId: string;
      at: number;
      phoneNumberId?: string;
    } & MessageContent)
  | {
      /** Emitted by Eccos, never by Meta: a scheduled send that will not be sent. */
      type: "scheduled_failed";
      /** The key it was scheduled under. */
      scheduleKey: string;
      /** The recipient as it was scheduled. */
      to: string;
      /** `rejected`: Meta refused it. `expired`: not sent before `expiresAt`. `unknown`: Meta may have sent it; never retried. */
      reason: "rejected" | "expired" | "unknown";
      /** Meta's error code and message, when Meta answered with one. */
      errorCode?: string;
      errorMessage?: string;
      /** When Eccos gave it up (ms since epoch). */
      at: number;
      phoneNumberId?: string;
    };

export type ScheduledFailedEvent = Extract<WhatsAppCallbackEvent, { type: "scheduled_failed" }>;
