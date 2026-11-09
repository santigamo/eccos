/**
 * Daily operator census to the Telegram HQ ops topic (eccos-r8x0).
 *
 * Runs from the 5-minute cron tick, at most once per UTC day at or after 07:00 UTC. The day is
 * checked read-only first, the data is gathered, and the control plane's `claimDailyCensus`
 * is claimed atomically just before sending: a crash while gathering leaves the day open for
 * the next tick, while a retried tick or a second isolate cannot send twice. A send that
 * Telegram rejected is not retried (a dropped connection can arrive after Telegram posted it),
 * so that day is skipped.
 *
 * Ids, names and counts only: no phone numbers, message content or tokens.
 */
import { getControlPlaneStub } from "./control-plane-stub";
import { runBoundedPool } from "./gateway";
import { getGatewayStubForWaba } from "./gateway-stub";
import { opsAlertsEnabled, sendOpsAlert } from "./ops-alert";

const CENSUS_HOUR_UTC = 7;
const DAY_MS = 24 * 3600_000;
const CENSUS_CONCURRENCY = 5;
const WABA_READ_TIMEOUT_MS = 10_000;
// Telegram rejects text over 4096 characters.
const CHUNK_CHARS = 3800;

interface WabaLine {
  wabaId: string;
  status: string;
  onboarding: string;
  sync: string;
  /** Null until the data plane was read, and for a WABA that is not active. */
  hasTarget: boolean | null;
  pending: number;
  /** Pending deliveries waiting for a forwarding target. */
  held: number;
  /** Failed deliveries still within delivery retention. */
  failed: number;
  recentFailed: number;
  /** Delivered among the deliveries queued in the last 24 h. */
  delivered24h: number;
  /** Events held because the WABA is not active (held_webhooks). */
  heldWebhooks: number;
  stuckPending: boolean;
  readable: boolean;
}

interface AccountBlock {
  name: string;
  organizationId: string | null;
  wabas: WabaLine[];
}

// Terminal sync states that need the operator. `unavailable` and `not_coexistence` are terminal non-failures.
const SYNC_NEEDS_ACTION = new Set(["unconfirmed", "expired"]);

export async function runDailyCensus(
  env: Env,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
  readTimeoutMs = WABA_READ_TIMEOUT_MS,
): Promise<void> {
  if (!opsAlertsEnabled(env)) return;
  const date = new Date(now);
  if (date.getUTCHours() < CENSUS_HOUR_UTC) return;
  const day = date.toISOString().slice(0, 10);
  const control = getControlPlaneStub(env);
  if (await control.censusClaimed(day)) return;

  const accounts = await control.listCensusAccounts();
  const blocks: AccountBlock[] = accounts.map((a) => ({
    name: a.name || a.accountId,
    organizationId: a.organizationId,
    wabas: a.wabas.map((w) => ({
      wabaId: w.wabaId,
      status: w.status,
      onboarding: w.coexistence.onboardingType,
      sync: w.coexistence.status,
      hasTarget: null,
      pending: 0,
      held: 0,
      failed: 0,
      recentFailed: 0,
      delivered24h: 0,
      heldWebhooks: 0,
      stuckPending: w.status === "pending" && now - w.createdAt > DAY_MS,
      readable: true,
    })),
  }));

  // A pending or failed WABA can hold webhooks, so every WABA is read.
  await runBoundedPool(
    blocks.flatMap((b) => b.wabas),
    CENSUS_CONCURRENCY,
    async (line) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const census = await Promise.race([
          getGatewayStubForWaba(env, line.wabaId).getCensus(now - DAY_MS),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), readTimeoutMs);
          }),
        ]);
        const waiting = census.deliveries.pending ?? 0;
        if (line.status === "active") line.hasTarget = census.hasTarget;
        line.held = census.hasTarget ? 0 : waiting;
        line.pending = census.hasTarget ? waiting : 0;
        line.failed = census.deliveries.failed ?? 0;
        line.recentFailed = census.recent.failed;
        line.delivered24h = census.recent.delivered;
        line.heldWebhooks = census.heldEventCount;
      } catch {
        line.readable = false;
      } finally {
        clearTimeout(timer);
      }
    },
  );

  if (!(await control.claimDailyCensus(day))) return;
  for (const chunk of chunkLines(formatCensus(day, blocks).split("\n"))) {
    if ((await sendOpsAlert(env, chunk, fetchImpl)) !== "sent") return;
  }
}

export function formatCensus(day: string, blocks: AccountBlock[]): string {
  const wabas = blocks.flatMap((b) => b.wabas);
  const sum = (pick: (w: WabaLine) => number) => wabas.reduce((n, w) => n + pick(w), 0);
  const byStatus = ["active", "pending", "failed"]
    .map((s) => [s, wabas.filter((w) => w.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  const events = (n: number) => `${n} ${n === 1 ? "event" : "events"}`;
  const attention: string[] = [];
  for (const b of blocks) {
    for (const w of b.wabas) {
      const who = `${b.name} / WABA ${w.wabaId}`;
      if (w.status === "failed") attention.push(`${who}: provisioning failed`);
      if (w.stuckPending) attention.push(`${who}: still pending, registered over 24 h ago`);
      if (!w.readable) attention.push(`${who}: data plane unreadable`);
      if (w.recentFailed > 0) {
        attention.push(`${who}: ${w.recentFailed} ${w.recentFailed === 1 ? "delivery" : "deliveries"} failed in the last 24 h`);
      }
      if (w.held > 0) attention.push(`${who}: ${events(w.held)} held: no forwarding target`);
      if (w.heldWebhooks > 0) attention.push(`${who}: ${events(w.heldWebhooks)} held: WABA not active`);
      if (SYNC_NEEDS_ACTION.has(w.sync)) attention.push(`${who}: coexistence sync ${w.sync}`);
    }
  }

  const lines = [
    `Eccos daily census, ${day} UTC`,
    `${blocks.length} ${blocks.length === 1 ? "account" : "accounts"}, ${wabas.length} ${wabas.length === 1 ? "WABA" : "WABAs"}${byStatus ? ` (${byStatus})` : ""}`,
    `Deliveries: ${sum((w) => w.pending)} pending, ${sum((w) => w.held)} held: no forwarding target, ${sum((w) => w.failed)} failed, ${sum((w) => w.delivered24h)} delivered (queued in the last 24 h)`,
    `Webhooks held: WABA not active: ${events(sum((w) => w.heldWebhooks))}`,
    "",
    attention.length > 0 ? "Needs attention" : "Nothing needs attention",
    ...attention.map((line) => `- ${line}`),
  ];
  for (const b of blocks) {
    lines.push("", b.organizationId ? `${b.name} (org ${b.organizationId})` : b.name);
    if (b.wabas.length === 0) lines.push("  no WABAs");
    for (const w of b.wabas) {
      const kind = w.onboarding === "coexistence" ? `coexistence, sync ${w.sync}` : w.onboarding;
      const target = w.hasTarget === null ? "" : w.hasTarget ? ", target set" : ", no target";
      const counts = w.readable
        ? `: ${w.pending} pending, ${w.held} held: no forwarding target, ${w.failed} failed, ${w.delivered24h} delivered (queued 24 h), ${w.heldWebhooks} held: WABA not active`
        : ": unreadable";
      lines.push(`  WABA ${w.wabaId}, ${w.status}, ${kind}${target}${counts}`);
    }
  }
  return lines.join("\n");
}

export function chunkLines(lines: string[], limit = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit && current) {
      chunks.push(current);
      current = line;
    } else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}
