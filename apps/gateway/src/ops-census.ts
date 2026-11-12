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
 * Every active WABA's token is checked against Meta's debug_token (inside the control plane, so
 * the token never leaves it). A token that is invalid or close to expiry gets its own alert, with
 * WABA and account ids only; checks that got no answer are one separate alert.
 *
 * Ids, names and counts only: no phone numbers, message content or tokens.
 */
import { getControlPlaneStub } from "./control-plane-stub";
import { runBoundedPool } from "./gateway";
import { getGatewayStubForWaba } from "./gateway-stub";
import { opsAlertsEnabled, sendOpsAlert } from "./ops-alert";
import { withTimeout } from "./with-timeout";
import { formatDay, type TokenCheck, type TokenHealth, tokenProblems, type Unchecked } from "./token-health";

const CENSUS_HOUR_UTC = 7;
const DAY_MS = 24 * 3600_000;
const CENSUS_CONCURRENCY = 5;
const WABA_READ_TIMEOUT_MS = 10_000;
// debug_token itself times out at 15 s.
const TOKEN_CHECK_TIMEOUT_MS = 20_000;
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
  /** Null when the WABA is not active or the check got no answer. */
  token: TokenHealth | null;
  /** Why an active WABA's token could not be checked. */
  tokenUnchecked: Unchecked | null;
  /** The stored token the check was about. */
  tokenSealed?: string;
  /** What the last successful check stored, for when today's check got no answer. */
  storedToken: TokenHealth;
}

interface AccountBlock {
  accountId: string;
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
  tokenTimeoutMs = TOKEN_CHECK_TIMEOUT_MS,
): Promise<void> {
  if (!opsAlertsEnabled(env)) return;
  const date = new Date(now);
  if (date.getUTCHours() < CENSUS_HOUR_UTC) return;
  const day = date.toISOString().slice(0, 10);
  const control = getControlPlaneStub(env);
  if (await control.censusClaimed(day)) return;

  const accounts = await control.listCensusAccounts();
  const blocks: AccountBlock[] = accounts.map((a) => ({
    accountId: a.accountId,
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
      token: null,
      tokenUnchecked: null,
      storedToken: { valid: true, expiresAt: w.tokenExpiresAt, dataAccessExpiresAt: w.tokenDataAccessExpiresAt },
    })),
  }));

  const readDataPlane = async (line: WabaLine) => {
    try {
      const census = await withTimeout(getGatewayStubForWaba(env, line.wabaId).getCensus(now - DAY_MS), readTimeoutMs);
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
    }
  };
  // Independent of the data plane read: a slow debug_token never makes a WABA unreadable.
  const checkToken = async (line: WabaLine) => {
    if (line.status !== "active") return;
    try {
      const check = await withTimeout(control.checkTokenHealth(line.wabaId) as Promise<TokenCheck>, tokenTimeoutMs);
      if ("health" in check) {
        line.token = check.health;
        line.tokenSealed = check.sealed;
      }
      else line.tokenUnchecked = check.unchecked;
    } catch {
      line.tokenUnchecked = "meta_no_answer";
    }
  };

  // A pending or failed WABA can hold webhooks, so every WABA is read.
  await runBoundedPool(blocks.flatMap((b) => b.wabas), CENSUS_CONCURRENCY, async (line) => {
    await Promise.all([readDataPlane(line), checkToken(line)]);
  });

  if (!(await control.claimDailyCensus(day))) return;
  const lost = await control.lostTokenAlerts();
  const problems = [
    ...tokenAlertLines(blocks, now),
    ...lost.map(({ wabaId, accountId }) => `WABA ${wabaId} · account ${accountId}: Meta rejected the token on send, the alert may not have arrived`),
  ];
  const unchecked = uncheckedAlertLines(blocks);
  if (problems.length > 0 && (await sendChunked(env, ["Eccos: WhatsApp tokens need attention", ...problems], fetchImpl))) {
    await control.markTokensAlerted(
      blocks.flatMap((b) =>
        b.wabas.flatMap((w) => (w.token?.valid === false && w.tokenSealed ? [{ wabaId: w.wabaId, sealed: w.tokenSealed }] : [])),
      ),
    );
    await control.clearLostTokenAlerts(lost.map((l) => l.wabaId));
  }
  if (unchecked.length > 0) await sendChunked(env, ["Eccos: cannot check WhatsApp tokens", ...unchecked], fetchImpl);
  for (const chunk of chunkLines(formatCensus(day, blocks).split("\n"))) {
    if ((await sendOpsAlert(env, chunk, fetchImpl)) !== "sent") return;
  }
}

async function sendChunked(env: Env, lines: string[], fetchImpl: typeof fetch): Promise<boolean> {
  let sent = true;
  for (const chunk of chunkLines(lines)) sent = (await sendOpsAlert(env, chunk, fetchImpl)) === "sent" && sent;
  return sent;
}

const UNCHECKED_REASON: Record<Unchecked, string> = {
  no_app_id: "META_APP_ID is not set",
  no_token: "no stored token",
  token_unreadable: "stored token cannot be decrypted",
  foreign_app: "token was issued by another Meta app",
  no_verdict: "debug_token did not say whether the token is valid",
  meta_no_answer: "Meta debug_token gave no answer",
};

/** A missing app id is one deployment-wide line; the other reasons name the WABA. */
function uncheckedAlertLines(blocks: AccountBlock[]): string[] {
  const lines = new Set<string>();
  for (const w of blocks.flatMap((b) => b.wabas)) {
    if (!w.tokenUnchecked) continue;
    lines.add(w.tokenUnchecked === "no_app_id" ? "META_APP_ID is not set, tokens are not checked" : `WABA ${w.wabaId}: ${UNCHECKED_REASON[w.tokenUnchecked]}`);
  }
  return [...lines];
}

function tokenAlertLines(blocks: AccountBlock[], now: number): string[] {
  return blocks.flatMap((b) =>
    b.wabas.flatMap((w) => {
      const problems = w.token
        ? tokenProblems(w.token, now)
        : w.tokenUnchecked
          ? tokenProblems(w.storedToken, now, true)
          : [];
      return problems.map((p) => `WABA ${w.wabaId} · account ${b.accountId}: ${p}`);
    }),
  );
}

function describeToken({ token: health, tokenUnchecked }: WabaLine): string {
  if (tokenUnchecked) return ", token unchecked";
  if (!health) return "";
  if (!health.valid) return ", token invalid";
  const expiry =
    health.expiresAt === null ? "expiry unknown" : health.expiresAt ? `expires ${formatDay(health.expiresAt)}` : "never expires";
  const access = health.dataAccessExpiresAt ? `, data access ${formatDay(health.dataAccessExpiresAt)}` : "";
  return `, token ${expiry}${access}`;
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
      lines.push(`  WABA ${w.wabaId}, ${w.status}, ${kind}${target}${describeToken(w)}${counts}`);
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
