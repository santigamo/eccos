/**
 * Daily operator census to the Telegram HQ ops topic (eccos-r8x0).
 *
 * Runs from the 5-minute cron tick, at most once per UTC day after 07:00 UTC; the
 * control plane's `claimDailyCensus` is the guard, so a retried tick or a second
 * isolate cannot send twice. The day is claimed before sending and kept on a failed
 * send: like every ops message it is never retried, because a dropped connection can
 * arrive after Telegram posted it.
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
// Telegram rejects text over 4096 characters.
const CHUNK_CHARS = 3800;

interface WabaLine {
  wabaId: string;
  status: string;
  onboarding: string;
  sync: string;
  hasTarget: boolean | null;
  pending: number;
  held: number;
  failed: number;
  delivered24h: number;
  readable: boolean;
}

interface AccountBlock {
  name: string;
  organizationId: string | null;
  wabas: WabaLine[];
}

const PROBLEM_SYNC = new Set(["unavailable", "expired", "not_coexistence"]);

export async function runDailyCensus(env: Env, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!opsAlertsEnabled(env)) return;
  const date = new Date(now);
  if (date.getUTCHours() < CENSUS_HOUR_UTC) return;
  const day = date.toISOString().slice(0, 10);
  const control = getControlPlaneStub(env);
  if (!(await control.claimDailyCensus(day))) return;

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
      delivered24h: 0,
      readable: true,
    })),
  }));

  // Only an active WABA has a data plane worth waking.
  const active = blocks.flatMap((b) => b.wabas).filter((w) => w.status === "active");
  await runBoundedPool(active, CENSUS_CONCURRENCY, async (line) => {
    try {
      const census = await getGatewayStubForWaba(env, line.wabaId).getCensus(now - DAY_MS);
      const waiting = census.deliveries.pending ?? 0;
      line.hasTarget = census.hasTarget;
      line.held = census.hasTarget ? 0 : waiting;
      line.pending = census.hasTarget ? waiting : 0;
      line.failed = census.deliveries.failed ?? 0;
      line.delivered24h = census.deliveredSince;
    } catch {
      line.readable = false;
    }
  });

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
  const attention: string[] = [];
  for (const b of blocks) {
    for (const w of b.wabas) {
      const who = `${b.name} / WABA ${w.wabaId}`;
      if (w.status === "failed") attention.push(`${who}: provisioning failed`);
      if (!w.readable) attention.push(`${who}: data plane unreadable`);
      if (w.failed > 0) attention.push(`${who}: ${w.failed} failed ${w.failed === 1 ? "delivery" : "deliveries"}`);
      if (w.held > 0) attention.push(`${who}: ${w.held} ${w.held === 1 ? "event" : "events"} held, no forwarding target`);
      if (PROBLEM_SYNC.has(w.sync)) attention.push(`${who}: coexistence sync ${w.sync}`);
    }
  }

  const lines = [
    `Eccos daily census, ${day} UTC`,
    `${blocks.length} ${blocks.length === 1 ? "account" : "accounts"}, ${wabas.length} ${wabas.length === 1 ? "WABA" : "WABAs"}${byStatus ? ` (${byStatus})` : ""}`,
    `Deliveries: ${sum((w) => w.pending)} pending, ${sum((w) => w.held)} held, ${sum((w) => w.failed)} failed, ${sum((w) => w.delivered24h)} delivered in the last 24 h`,
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
      const counts =
        w.readable && w.status === "active"
          ? `: ${w.pending} pending, ${w.held} held, ${w.failed} failed, ${w.delivered24h} delivered 24 h`
          : "";
      lines.push(`  WABA ${w.wabaId}, ${w.status}, ${kind}${target}${counts}`);
    }
  }
  return lines.join("\n");
}

function chunkLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > CHUNK_CHARS && current) {
      chunks.push(current);
      current = line;
    } else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}
