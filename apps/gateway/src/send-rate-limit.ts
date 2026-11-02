/**
 * Send rate limit. Accounts listed in `HIGH_THROUGHPUT_ACCOUNTS` draw from the
 * `SEND_RATE_LIMITER_HIGH` binding, everyone else from `SEND_RATE_LIMITER`. The
 * key is shared by API and console sends, so one budget covers both.
 */

export type SendRateLimitEnv = Pick<Env, "SEND_RATE_LIMITER" | "SEND_RATE_LIMITER_HIGH" | "HIGH_THROUGHPUT_ACCOUNTS">;

/** The per-minute rates of the two limiter bindings in wrangler.jsonc; broadcasts pace to them. */
export const DEFAULT_SEND_RATE = 60;
export const HIGH_SEND_RATE = 600;

function isHighThroughput(env: SendRateLimitEnv, accountId: string): boolean {
  return (env.HIGH_THROUGHPUT_ACCOUNTS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(accountId);
}

export function sendRatePerMinute(env: SendRateLimitEnv, accountId: string): number {
  return isHighThroughput(env, accountId) && env.SEND_RATE_LIMITER_HIGH ? HIGH_SEND_RATE : DEFAULT_SEND_RATE;
}

/** True when the send may proceed; always true with no limiter bound. */
export async function checkSendRate(env: SendRateLimitEnv, accountId: string, wabaId: string): Promise<boolean> {
  const limiter = isHighThroughput(env, accountId) && env.SEND_RATE_LIMITER_HIGH ? env.SEND_RATE_LIMITER_HIGH : env.SEND_RATE_LIMITER;
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: `${accountId}:${wabaId}` });
  return success;
}
