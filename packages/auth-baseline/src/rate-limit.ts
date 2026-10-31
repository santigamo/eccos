/**
 * Auth rate limiting, shared by every Better Auth instance on Cloudflare.
 *
 * Buckets key on `${clientIP}|${path}`, never on the request body: these rules
 * cap one caller, they are not a per-recipient guarantee. Database storage
 * shares the counters across isolates.
 */
export const authRateLimit = {
  enabled: true,
  window: 60,
  max: 100,
  storage: "database" as const,
  customRules: {
    "/sign-in/email": { window: 300, max: 10 },
    "/sign-up/email": { window: 3600, max: 20 },
    "/request-password-reset": { window: 3600, max: 10 },
    // Unauthenticated, caller-supplied address, real mail on every call: without
    // its own rule this endpoint is an email-bombing primitive aimed at a third
    // party's inbox (eccos-hk5). 5 per 300 s caps one caller at 60 mails/hour,
    // against ~180/hour for the framework default (60 s / 3) and 6000/hour for
    // the global rule.
    "/send-verification-email": { window: 300, max: 5 },
    "/organization/invite-member": { window: 3600, max: 50 },
  },
};

/**
 * The client IP is read from `cf-connecting-ip` ONLY (eccos-fzgx, eccos-g5h).
 *
 * Better Auth's default is `x-forwarded-for`, which the caller controls:
 * Cloudflare appends to a client-supplied XFF, a two-value header resolves to
 * no IP, and every such caller lands in ONE shared per-path bucket, so a single
 * spoofer could lock everyone out of sign-in, sign-up and resend.
 * `cf-connecting-ip` is set by the edge on every proxied request and overwrites
 * any client value.
 *
 * Without the header (local dev, tests) Better Auth keys on 127.0.0.1 when
 * NODE_ENV is test/development, and otherwise on one shared `no-trusted-ip`
 * bucket per path. That fallback is never keyed on a caller-chosen value and is
 * unreachable from the internet behind Cloudflare.
 */
export const authIpAddress = {
  ipAddressHeaders: ["cf-connecting-ip"],
};
