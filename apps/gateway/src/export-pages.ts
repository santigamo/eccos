/**
 * The data-plane export, read in keyset pages. `exportData()` reads each section in one page; the
 * streamed HTTP export reads short pages so no single read holds the Durable Object for long.
 * Every page seeks on the section's own sort order (an index or the primary key), never OFFSET,
 * and binds at most four parameters.
 */
import { MESSAGE_COLUMNS, toMessageRecord } from "./conversations";

/** The paged sections of `GatewayExport`, in its key order; `config` follows them, read whole. */
export const EXPORT_SECTIONS = ["inbound", "outbound", "deliveries", "messages", "contacts", "held", "customerIds"] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

/** The keyset parameters that start the next page. */
export type ExportCursor = Array<string | number>;
export interface ExportPage {
  rows: unknown[];
  next: ExportCursor | null;
}

export const EXPORT_PAGE_ROWS = 500;
/** Characters of row data per page, so a page of large delivery payloads stays a short read. */
export const EXPORT_PAGE_CHARS = 2_000_000;

type Raw = Record<string, SqlStorageValue>;

interface Reader {
  select: string;
  /** The keyset condition after a cursor; its parameters are the cursor. */
  after: string;
  order: string;
  cursor(raw: Raw): ExportCursor;
  row(raw: Raw): unknown;
}

const asIs = (raw: Raw): unknown => raw;
const byIdDesc = (select: string): Reader => ({
  select,
  after: "id < ?",
  order: "id DESC",
  cursor: (raw) => [Number(raw.id)],
  row: asIs,
});

// The export is the STORED rows: `delivery_id` is a column, the console's joins are not.
const READERS: Record<ExportSection, Reader> = {
  inbound: byIdDesc(
    "SELECT id, type, transport_message_id, message_id, phone_number_id, payload, received_at, delivery_id FROM inbound_events",
  ),
  outbound: byIdDesc(
    "SELECT id, transport_message_id, recipient, phone_number_id, request, status, error, created_at FROM outbound_messages",
  ),
  deliveries: byIdDesc(
    "SELECT id, phone_number_id, status, attempts, last_error, next_attempt_at, created_at, finished_at, payload FROM deliveries",
  ),
  messages: {
    select: `SELECT rowid AS seq, ${MESSAGE_COLUMNS} FROM messages`,
    // `at <= ?` keeps the seek on idx_messages_at.
    after: "at <= ? AND (at < ? OR rowid < ?)",
    order: "at DESC, rowid DESC",
    cursor: (raw) => [Number(raw.at), Number(raw.at), Number(raw.seq)],
    row: toMessageRecord,
  },
  contacts: {
    select: "SELECT wa_id, name, source, updated_at FROM contacts",
    after: "wa_id > ?",
    order: "wa_id",
    cursor: (raw) => [raw.wa_id as string],
    row: (raw) => ({
      waId: raw.wa_id as string,
      name: (raw.name as string | null) ?? null,
      source: raw.source as string,
      updatedAt: Number(raw.updated_at),
    }),
  },
  held: {
    select: "SELECT id, phone_number_id, events, event_count, held_at FROM held_webhooks",
    after: "id > ?",
    order: "id",
    cursor: (raw) => [Number(raw.id)],
    row: asIs,
  },
  customerIds: {
    select: "SELECT user_id, wa_id FROM customer_ids",
    after: "user_id > ?",
    order: "user_id",
    cursor: (raw) => [raw.user_id as string],
    row: (raw) => ({ userId: raw.user_id as string, waId: raw.wa_id as string }),
  },
};

/** One page of a section from `after` (null: the first page). `next` is null once the section is done. */
export function readExportPage(
  sql: SqlStorage,
  section: ExportSection,
  after: ExportCursor | null,
  maxRows = EXPORT_PAGE_ROWS,
  maxChars = EXPORT_PAGE_CHARS,
): ExportPage {
  const reader = READERS[section];
  const where = after ? ` WHERE ${reader.after}` : "";
  const rows: unknown[] = [];
  let chars = 0;
  let last: Raw | undefined;
  for (const raw of sql.exec(`${reader.select}${where} ORDER BY ${reader.order} LIMIT ?`, ...(after ?? []), maxRows)) {
    rows.push(reader.row(raw));
    last = raw;
    chars += rowChars(raw);
    if (chars >= maxChars) break;
  }
  const full = rows.length === maxRows || chars >= maxChars;
  return { rows, next: full && last ? reader.cursor(last) : null };
}

/** A whole section in one read. */
export function readExportSection(sql: SqlStorage, section: ExportSection): unknown[] {
  return readExportPage(sql, section, null, -1, Number.POSITIVE_INFINITY).rows;
}

function rowChars(raw: Raw): number {
  let n = 0;
  for (const value of Object.values(raw)) n += typeof value === "string" ? value.length : 8;
  return n;
}
