/** The shipped D1 migrations must produce the schema Better Auth writes to:
 * the other tests build theirs from `getMigrations`, so drift only shows here. */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth/auth";
import { CaptureMailSender } from "../src/auth/mail";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

function columns(db: Database): string[] {
  const tables = db
    .query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .all() as { name: string }[];
  return tables.flatMap(({ name }) =>
    (db.query(`pragma table_info("${name}")`).all() as { name: string; notnull: number }[]).map(
      (c) => `${name}.${c.name}${c.notnull ? " not null" : ""}`,
    ),
  ).sort();
}

function authOn(db: Database) {
  return createAuth({
    database: db,
    secret: "test-secret-32-chars-minimum-length!!",
    baseURL: "http://localhost:3000",
    trustedOrigins: ["http://localhost:3000"],
    mail: new CaptureMailSender(),
  });
}

test("migrations/*.sql match the schema Better Auth expects", async () => {
  const shipped = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    shipped.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  const expected = new Database(":memory:");
  await (await getMigrations(authOn(expected).options)).runMigrations();

  expect(columns(shipped)).toEqual(columns(expected));
});
