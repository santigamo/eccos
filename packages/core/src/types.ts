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
    };
