/**
 * Operator alerts to the Telegram HQ forum (eccos-r8x0).
 *
 * Why this exists: a failed forward used to leave nothing but `last_error`
 * inside the customer's own Durable Object, with no log line and no alert. The
 * redirect bug (eccos-ugb6) failed every forward for every account for weeks,
 * and the operator heard about it from a customer's email.
 *
 * The contract:
 * - Off unless all three secrets are set (`OPS_TELEGRAM_BOT_TOKEN`,
 *   `OPS_TELEGRAM_CHAT_ID`, `OPS_TELEGRAM_THREAD_ID`). Self-hosters and tests
 *   never reach Telegram.
 * - One attempt, never retried: a dropped connection can arrive after Telegram
 *   already posted the message, and a retry would post it twice.
 * - Never throws: a failed alert must not break the delivery bookkeeping that
 *   triggered it.
 * - `message_thread_id` is checked in the reply. Without it Telegram posts to
 *   the forum's General channel and still answers `ok: true`.
 * - Identifiers and counts only: no message content, no end-user numbers. The
 *   bot token travels in the URL, so neither the URL nor a fetch error that
 *   could quote it is ever logged.
 */

export interface OpsAlertEnv {
  OPS_TELEGRAM_BOT_TOKEN?: string;
  OPS_TELEGRAM_CHAT_ID?: string;
  OPS_TELEGRAM_THREAD_ID?: string;
}

export type OpsAlertResult = "disabled" | "sent" | "failed";

const OPS_ALERT_TIMEOUT_MS = 5_000;

export async function sendOpsAlert(
  env: OpsAlertEnv,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpsAlertResult> {
  const token = env.OPS_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.OPS_TELEGRAM_CHAT_ID?.trim();
  const threadId = Number(env.OPS_TELEGRAM_THREAD_ID);
  if (!token || !chatId || !Number.isInteger(threadId) || threadId <= 0) return "disabled";

  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Plain text on purpose: an error string with an underscore or a bracket
      // would break Markdown parsing and the alert would be rejected.
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: threadId,
        text,
        link_preview_options: { is_disabled: true },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(OPS_ALERT_TIMEOUT_MS),
    });
    const reply = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_thread_id?: number };
    } | null;
    if (res.ok && reply?.ok && reply.result?.message_thread_id === threadId) return "sent";
    logAlertProblem("send-rejected", { status: res.status });
    return "failed";
  } catch (error) {
    logAlertProblem("send-error", { kind: error instanceof Error ? error.name : typeof error });
    return "failed";
  }
}

function logAlertProblem(event: string, extra: Record<string, string | number>): void {
  console.warn(JSON.stringify({ level: "warn", area: "ops-alert", event, ...extra }));
}
