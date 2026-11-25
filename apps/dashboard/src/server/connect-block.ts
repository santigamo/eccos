import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getAuthForRequest } from "../auth/request-auth";
import { requireGatewayPermission } from "../auth/server-auth";
import { ForbiddenError } from "../auth/tenant";

/** Why the connect fork cannot start: a role that may not connect. */
export type ConnectBlock = "missing-permission";

/**
 * What connecting a number would be refused for right now, for the Numbers
 * page. Judged exactly as `startConnect` judges it. Anything else (signed out,
 * no workspace yet) is the page's own state.
 */
export const getConnectBlock = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConnectBlock | null> => {
    const request = getRequest();
    try {
      await requireGatewayPermission(getAuthForRequest(request, env), request, "administer");
      return null;
    } catch (err) {
      return err instanceof ForbiddenError && err.reason === "missing-permission" ? err.reason : null;
    }
  },
);
