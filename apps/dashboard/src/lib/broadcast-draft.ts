import {
  analyzeTemplate,
  canSendTemplate,
  type TemplateRow,
} from "@eccos/core/template-rules";
import type {
  CreateBroadcastInput,
  TemplateHeaderMediaFormat,
} from "@eccos/gateway-contract";
import { fmtCount } from "../ui";
import {
  cleanValue,
  type ListCheck,
  type Mapping,
  type Slot,
} from "./recipient-list";

/**
 * The compose page's derived readings: the payload a frozen review sends, the
 * note beside the primary, and the time estimate. Pure.
 */

/** The browser refuses a payload past this, and so does the server function. */
export const MAX_BROADCAST_BYTES = 6 * 1024 * 1024;

export type BroadcastPayload = Omit<CreateBroadcastInput, "idempotencyKey">;

export function broadcastPayload(input: {
  wabaId: string;
  phoneNumberId: string;
  templateName: string;
  languageCode: string;
  label: string;
  slots: Slot[];
  mapping: Mapping;
  check: ListCheck;
  headerMedia: { format: TemplateHeaderMediaFormat; link: string } | null;
}): BroadcastPayload {
  const { slots, mapping } = input;
  const fixed = (slot: Slot) => {
    const source = mapping.sources[slot.id];
    return source && "fixed" in source ? cleanValue(source.fixed) : undefined;
  };
  const perRow = slots.flatMap((slot, i) =>
    fixed(slot) === undefined ? [i] : [],
  );
  const label = input.label.trim();
  return {
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
    templateName: input.templateName,
    languageCode: input.languageCode,
    ...(label ? { label } : {}),
    columns: slots.map((slot) => {
      const value = fixed(slot);
      const at =
        slot.kind === "body"
          ? { kind: "body" as const, key: slot.key }
          : { kind: "button" as const, index: Number(slot.key) };
      return value === undefined ? at : { ...at, fixed: value };
    }),
    ...(input.headerMedia
      ? {
          headerMedia: {
            format: input.headerMedia.format,
            link: input.headerMedia.link.trim(),
          },
        }
      : {}),
    recipients: input.check.rows
      .filter((row) => row.state === "send")
      .map((row) => ({
        to: row.digits ?? "",
        values: perRow.map((i) => row.values[i] ?? ""),
      })),
  };
}

/** Bytes the payload takes on the wire, from its JSON, with room for its key. */
export function payloadBytes(json: string): number {
  return json.length + 64;
}

/**
 * The idempotency key of a review: the same payload keeps the key it had, so a
 * review left and re-entered unchanged cannot start a second broadcast; any
 * change is a new broadcast and a new key.
 */
export function reviewKey(
  previous: { json: string; key: string } | null,
  json: string,
  mint: () => string,
): string {
  return previous?.json === json ? previous.key : mint();
}

/** Review is open only while what it froze is still what compose holds; Back and Forward cannot reopen a stale one. */
export function reviewOpen(
  wanted: boolean,
  frozenJson: string | null,
  currentJson: string | null,
): boolean {
  return wanted && frozenJson !== null && frozenJson === currentJson;
}

/**
 * The templates a broadcast can use: APPROVED and buildable by the console. Approved
 * ones it cannot build are listed apart with the reason; the rest are only counted.
 */
export function broadcastTemplates<T extends TemplateRow & { status?: string }>(
  rows: T[],
) {
  const ready: T[] = [];
  const unavailable: { row: T; reason: string }[] = [];
  for (const row of rows) {
    if (!canSendTemplate(row.status)) continue;
    const sendability = analyzeTemplate(row);
    if (sendability.kind === "ready") ready.push(row);
    else unavailable.push({ row, reason: sendability.reason });
  }
  return {
    ready,
    unavailable,
    others: rows.length - ready.length - unavailable.length,
  };
}

export const templateId = (row: { name?: string; language?: string }) =>
  `${row.name ?? ""}:${row.language ?? ""}`;

export function estimateMinutes(
  recipients: number,
  pacePerMinute: number,
): number {
  return Math.max(1, Math.ceil(recipients / Math.max(1, pacePerMinute)));
}

/** "51 min", "3 h 12 min". */
export function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

/** What the compose bar needs to say, first blocker first. */
export interface ComposeState {
  /** Sending refused for the workspace (billing), with the sentence that says why. */
  blocked: string | null;
  /** The WhatsApp Business Account has no phone number to send from. */
  noSender: boolean;
  hasTemplate: boolean;
  hasList: boolean;
  /** Data rows beyond the limit, when there are. */
  tooManyRows: number | null;
  maxRecipients: number;
  phoneMapped: boolean;
  /** The first slot with no source. */
  unmapped: Slot | null;
  /** The template needs a header link and none valid was given. */
  headerMissing: TemplateHeaderMediaFormat | null;
  sendable: number;
  total: number;
  bytes: number;
  pacePerMinute: number;
}

export function composeNote(state: ComposeState): {
  blocker: string | null;
  note: string;
} {
  const blocker = composeBlocker(state);
  if (blocker) return { blocker, note: blocker };
  const minutes = fmtMinutes(
    estimateMinutes(state.sendable, state.pacePerMinute),
  );
  return {
    blocker: null,
    note: `${fmtCount(state.sendable)} of ${fmtCount(state.total)} rows will be sent, in about ${minutes}.`,
  };
}

function composeBlocker(state: ComposeState): string | null {
  if (state.blocked) return state.blocked;
  if (state.noSender)
    return "This WhatsApp Business Account has no phone number to send from yet.";
  if (!state.hasTemplate)
    return state.hasList
      ? "Choose a template to continue."
      : "Choose a template and add your list.";
  if (!state.hasList) return "Add your list to continue.";
  if (state.tooManyRows !== null) {
    return `This list has ${fmtCount(state.tooManyRows)} rows. A broadcast holds up to ${fmtCount(state.maxRecipients)}: split it into two.`;
  }
  if (!state.phoneMapped)
    return "Choose the column that holds the phone numbers.";
  if (state.unmapped) return `Choose a column for ${state.unmapped.label}.`;
  if (state.headerMissing)
    return `Add the link to the ${state.headerMissing} for the header.`;
  if (state.sendable === 0)
    return "No row in this list can be sent. Check the phone column.";
  if (state.bytes > MAX_BROADCAST_BYTES)
    return "This list is too large to send as one broadcast. Split it into two.";
  return null;
}
