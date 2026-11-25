import { deliver, NUMBERS_PATH, settle, type FunnelDeps } from "./funnel-mail";

/** The recovery email goes out 2 hours after the first connect try. */
export const RECOVERY_DELAY_MS = 2 * 60 * 60 * 1000;

/** What we can say about the cause, only for the Meta errors the wizard knows. Said with care: it is a guess from afar. */
const CAUSES: Record<string, string> = {
  "3441067":
    "It looks like another WhatsApp provider is still holding it. Normally, once they release the number, it connects on the next try.",
  "3441069":
    "It looks like the number is still in use in the regular WhatsApp app. Normally, once it is free there, it connects on the next try.",
  "3441075":
    "It looks like Meta asked for the 6-digit PIN that protects the number. Normally, with the PIN at hand, it connects on the next try.",
};

export function recoverySituation(cause: string | null): string {
  const known = cause ? CAUSES[cause] : undefined;
  return known ? `I saw your number did not get connected. ${known}` : "I saw your number did not get connected.";
}

/** At connect start. Only the first try counts, so a later one never pushes the email back. */
export async function scheduleRecovery(
  db: D1Database,
  row: { accountId: string; organizationId: string },
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO "funnelMail" ("accountId", "kind", "organizationId", "dueAt") VALUES (?, 'recovery', ?, ?)
       ON CONFLICT ("accountId", "kind") DO NOTHING`,
    )
    .bind(row.accountId, row.organizationId, now + RECOVERY_DELAY_MS)
    .run();
}

/** A Meta error reported from inside the signup window: the latest one names the cause. */
export async function noteConnectError(db: D1Database, accountId: string, code: string): Promise<void> {
  await db
    .prepare(`UPDATE "funnelMail" SET "cause" = ? WHERE "accountId" = ? AND "kind" = 'recovery' AND "settledAt" IS NULL`)
    .bind(code, accountId)
    .run();
}

/** The ledger never fails a connect: a missed recovery email is the whole cost. */
export function funnelLedgerFailed(err: unknown): void {
  console.error(
    JSON.stringify({ level: "error", area: "funnel-mail", event: "ledger-failed", error: err instanceof Error ? err.name : "unknown" }),
  );
}

/** From the cron: each due recovery is sent, or settled unsent once the account has a number. */
export async function runDueRecoveries(deps: FunnelDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const { results } = await deps.db
    .prepare(
      `SELECT "accountId", "organizationId", "cause" FROM "funnelMail"
       WHERE "kind" = 'recovery' AND "settledAt" IS NULL AND "dueAt" <= ? LIMIT 50`,
    )
    .bind(now)
    .all<{ accountId: string; organizationId: string; cause: string | null }>();
  for (const row of results) {
    try {
      const { phones } = await deps.gateway.listAccountResources(row.accountId);
      if (phones.length) {
        await settle(deps.db, row.accountId, "recovery", now);
        continue;
      }
      await deliver(deps, { ...row, kind: "recovery" }, "funnel-recovery", {
        situation: recoverySituation(row.cause),
        url: new URL(NUMBERS_PATH, deps.origin).href,
      });
    } catch (err) {
      console.error(
        JSON.stringify({ level: "error", area: "funnel-mail", event: "recovery-failed", error: err instanceof Error ? err.name : "unknown" }),
      );
    }
  }
}
