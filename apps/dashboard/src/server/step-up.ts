import * as Sentry from "@sentry/cloudflare";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuthForRequest } from "../auth/request-auth";
import { confirmStepUp, type ConfirmStepUpResult } from "../auth/step-up-confirm";

const input = z
  .object({ code: z.string().trim().min(1).max(64), backup: z.boolean().optional() })
  .strict();

/**
 * Verify an authenticator or backup code against the caller's own session.
 * `unavailable` is a failure that says nothing about the code: it is reported,
 * the operator is asked to retry, and no attempt was spent.
 */
export const confirmStepUpCode = createServerFn({ method: "POST" })
  .validator((value: unknown) => input.parse(value))
  .handler(async ({ data }): Promise<ConfirmStepUpResult | { ok: false; code: "unavailable" }> => {
    const request = getRequest();
    try {
      return await confirmStepUp(getAuthForRequest(request, env), request.headers, data);
    } catch (error) {
      Sentry.captureException(error);
      return { ok: false, code: "unavailable" };
    }
  });
