/**
 * Shared by the Worker and the browser. The DSN is baked in at build time
 * (`VITE_SENTRY_DSN`, read from the repo `.env` by the deploy script); unset
 * (the self-host default) disables the SDK. Errors only, no request or user data.
 */
export const sentryOptions = {
  dsn: import.meta.env.VITE_SENTRY_DSN as string | undefined,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
  },
};
