/**
 * Better Auth client for the dashboard UI (eccos-0x0.4, contract §5).
 *
 * The client is only a convenience for forms (sign-in/sign-up/reset) and
 * session reads in the browser; every authorization decision stays
 * server-side. Mirrors the server organization plugin configuration so
 * custom roles infer correctly on the client.
 */

import { createAuthClient } from "better-auth/react";
import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { ac, owner, admin, operator, viewer } from "./permissions";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
  plugins: [
    organizationClient({
      ac,
      roles: { owner, admin, operator, viewer },
    }),
    twoFactorClient(),
  ],
});
