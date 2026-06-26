import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Open the SQLite database, creating the file/dir and schema if needed.
 * Schema is created idempotently on boot so self-hosting is a single step
 * (no separate migrate command for v1).
 */
export function openDb(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  ensureSchema(db);
  return db;
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbound_messages (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      transport_message_id  TEXT,
      recipient             TEXT NOT NULL,
      request               TEXT NOT NULL,
      status                TEXT NOT NULL,
      error                 TEXT,
      created_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      payload         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      next_attempt_at INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deliveries_pending
      ON deliveries (status, next_attempt_at);
  `);
}
