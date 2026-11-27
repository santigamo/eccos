import type { BroadcastSummary, TemplateHeaderMedia } from "./index";

/** The gateway refuses a recipient whose components, as JSON, are longer than this. */
export const MAX_RECIPIENT_COMPONENTS_BYTES = 8 * 1024;

/**
 * One variable a broadcast fills, in the order of each recipient's `values`.
 * `fixed` is one value for every recipient; such a column takes no entry in `values`.
 */
export type BroadcastColumn =
  | { kind: "body"; key: string; fixed?: string }
  /** A dynamic URL button, by its 0-based slot in the template's BUTTONS component. */
  | { kind: "button"; index: number; fixed?: string };

/**
 * A broadcast started from the console. Narrow for the same reason as
 * `SendTemplateTestInput`: the caller names a template and values, and the
 * gateway reads the template, checks the columns against it and builds every
 * recipient's components itself.
 */
export interface CreateBroadcastInput {
  wabaId: string;
  phoneNumberId: string;
  templateName: string;
  languageCode: string;
  /** 1 to 80 characters, seen only by the team; never sent to Meta. */
  label?: string;
  columns: BroadcastColumn[];
  headerMedia?: TemplateHeaderMedia;
  /** `to` is digits or a BSUID; `values` holds one entry per column without `fixed`, in column order. */
  recipients: { to: string; values: string[] }[];
  /** One per frozen review: a retry with the same key returns the same broadcast. */
  idempotencyKey: string;
}

export type CreateBroadcastFailureCode =
  | "subscription_required"
  | "no_phone"
  /** Some rows break the gateway's rules; `invalid` names them (up to 100). Nothing was queued. */
  | "invalid_recipients"
  | "invalid_request"
  | "too_large"
  | "too_many_running"
  | "template_not_found"
  /** `templateStatus` carries Meta's status. */
  | "template_not_approved"
  /** The template has parts the console cannot build. */
  | "template_unsupported"
  /** The columns do not match the template's variables as Meta stores them now. */
  | "parameter_mismatch"
  | "templates_unreachable"
  /** The idempotency key was used for a different broadcast. */
  | "key_reused";

export type CreateBroadcastResult =
  | { ok: true; broadcast: BroadcastSummary; replayed: boolean }
  | {
      ok: false;
      code: CreateBroadcastFailureCode;
      detail: string | null;
      invalid?: { index: number; error: string }[];
      templateStatus?: string;
    };

/** What the console needs before a broadcast starts, so it never hardcodes gateway constants. */
export interface BroadcastPreflight {
  running: number;
  maxRunning: number;
  /** Messages a minute a broadcast sends on this account. */
  pacePerMinute: number;
  maxRecipients: number;
}
