import type { CloudflareOptions } from "@sentry/cloudflare";

/** Errors only, and no request content: headers, bodies and query strings can carry
 * message text, phone numbers or API keys. Unset `SENTRY_DSN` (the self-host default)
 * disables the SDK. */
export function sentryOptions(env: object): CloudflareOptions {
  return {
    dsn: (env as { SENTRY_DSN?: string }).SENTRY_DSN,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
  };
}
