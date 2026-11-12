import { isStepUpReason, type StepUpReason } from "@eccos/auth-baseline/step-up";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getAuthForRequest } from "../auth/request-auth";
import { requireGatewayPermission } from "../auth/server-auth";
import { ForbiddenError } from "../auth/tenant";

/** Why the connect fork cannot start: the role, or the step-up still owed. */
export type ConnectBlock = "missing-permission" | StepUpReason;

/**
 * What connecting a number would be refused for right now, for the Numbers
 * page. Judged exactly as `startConnect` judges it, role first: a role that
 * may not connect is told so, never asked for a second factor it has no use
 * for. Anything else (signed out, no workspace yet) is the page's own state.
 */
export const getConnectBlock = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConnectBlock | null> => {
    const request = getRequest();
    try {
      await requireGatewayPermission(getAuthForRequest(request, env), request, "connect");
      return null;
    } catch (err) {
      if (!(err instanceof ForbiddenError)) return null;
      return err.reason === "missing-permission" || isStepUpReason(err.reason) ? err.reason : null;
    }
  },
);
