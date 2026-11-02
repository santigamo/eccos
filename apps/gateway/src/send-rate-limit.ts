/**
 * Send rate limit. Accounts listed in `HIGH_THROUGHPUT_ACCOUNTS` draw from the
 * `SEND_RATE_LIMITER_HIGH` binding, everyone else from `SEND_RATE_LIMITER`. The
 * key is shared by API and console sends, so one budget covers both.
 */

export interface SendRateLimitEnv {
  SEND_RATE_LIMITER?: RateLimit;
  SEND_RATE_LIMITER_HIGH?: RateLimit;
  HIGH_THROUGHPUT_ACCOUNTS?: string;
}

/** True when the send may proceed; always true with no limiter bound. */
export async function checkSendRate(env: SendRateLimitEnv, accountId: string, wabaId: string): Promise<boolean> {
  const listed = (env.HIGH_THROUGHPUT_ACCOUNTS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(accountId);
  const limiter = listed && env.SEND_RATE_LIMITER_HIGH ? env.SEND_RATE_LIMITER_HIGH : env.SEND_RATE_LIMITER;
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: `${accountId}:${wabaId}` });
  return success;
}
