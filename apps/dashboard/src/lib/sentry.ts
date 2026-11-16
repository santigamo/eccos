/**
 * Shared by the Worker and the browser. The DSN is baked in at build time
 * (`VITE_SENTRY_DSN`, read from the repo `.env` by the deploy script); unset
 * (the self-host default) disables the SDK. Errors only, no request or user data.
 */
const URL_FIELDS = ["from", "to", "url"] as const;

function withoutFragment<T>(value: T): T {
  return (typeof value === "string" ? value.replace(/#.*$/s, "") : value) as T;
}

type Crumb = { data?: Record<string, unknown> };
type Reported = { request?: { url?: string }; breadcrumbs?: Crumb[] };

/** A URL fragment never leaves the browser: on /connect it is the link token. */
export function scrubBreadcrumb<T extends Crumb>(breadcrumb: T): T {
  for (const field of URL_FIELDS) {
    if (breadcrumb.data && field in breadcrumb.data) breadcrumb.data[field] = withoutFragment(breadcrumb.data[field]);
  }
  return breadcrumb;
}

export function scrubEvent<T extends Reported>(event: T): T {
  if (event.request?.url) event.request.url = withoutFragment(event.request.url);
  event.breadcrumbs?.forEach(scrubBreadcrumb);
  return event;
}

export const sentryOptions = {
  dsn: import.meta.env.VITE_SENTRY_DSN as string | undefined,
  beforeBreadcrumb: scrubBreadcrumb,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
  },
};
