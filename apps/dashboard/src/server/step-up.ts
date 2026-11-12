import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuthForRequest } from "../auth/request-auth";
import { confirmStepUp, type ConfirmStepUpResult } from "../auth/step-up-confirm";

const input = z
  .object({ code: z.string().trim().min(1).max(64), backup: z.boolean().optional() })
  .strict();

/** Verify an authenticator or backup code against the caller's own session. */
export const confirmStepUpCode = createServerFn({ method: "POST" })
  .validator((value: unknown) => input.parse(value))
  .handler(({ data }): Promise<ConfirmStepUpResult> => {
    const request = getRequest();
    return confirmStepUp(getAuthForRequest(request, env), request.headers, data);
  });
