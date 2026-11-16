/**
 * Shared by the Worker and the browser. The DSN is baked in at build time
 * (`VITE_SENTRY_DSN`, read from the repo `.env` by the deploy script); unset
 * (the self-host default) disables the SDK. Errors only, no request or user data.
 */
/** A URL or a path, up to its fragment, wherever it sits in a string ("GET /connect#…" included). */
const URL_WITH_FRAGMENT = /((?:[a-z][a-z\d+.-]*:\/\/|\/)[^\s#]*)#\S*/gi;
/** Span attributes that hold a fragment on its own. */
const FRAGMENT_KEYS = new Set(["http.fragment", "url.fragment"]);

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.replace(URL_WITH_FRAGMENT, "$1");
  if (value === null || typeof value !== "object" || depth > 10) return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FRAGMENT_KEYS.has(key)) delete record[key];
    else record[key] = scrub(record[key], depth + 1);
  }
  return value;
}

/**
 * A URL fragment never leaves the browser: on /connect it is the link token.
 * Applied to every breadcrumb, event and transaction, whole: names, spans,
 * contexts and request alike, so no field has to be remembered here.
 */
export function scrubFragments<T>(payload: T): T {
  return scrub(payload, 0) as T;
}

export const sentryOptions = {
  dsn: import.meta.env.VITE_SENTRY_DSN as string | undefined,
  beforeBreadcrumb: scrubFragments,
  beforeSend: scrubFragments,
  beforeSendTransaction: scrubFragments,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
  },
};
