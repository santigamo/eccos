import * as Sentry from "@sentry/cloudflare";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getAuthForRequest } from "../auth/request-auth";
import { UnauthorizedError } from "../auth/server-auth";
import { ForbiddenError, resolveMemberships, type Membership } from "../auth/tenant";
import type { Failure } from "./gateway";

// Server-only, and imported only from server-function handlers: a client
// module that exported this would keep getRequest and env in the client bundle.

/**
 * Name the failure from the error's type (eccos-k5a).
 *
 * `ForbiddenError` and `UnauthorizedError` are raised by the identity plane
 * before the RPC is attempted, so they say nothing about the gateway; anything
 * else escaping the call is a transport or RPC failure, which is the only case
 * allowed to blame the service binding. `instanceof` is the discriminator, with
 * the class's own `name` brand as the fallback that survives a duplicated
 * module copy (bundler chunk, test mock) — never the message text.
 */
export async function classifyFailure(err: unknown): Promise<Failure> {
  if (err instanceof UnauthorizedError || isNamed(err, "UnauthorizedError")) {
    return { ok: false, kind: "unauthenticated", error: message(err) };
  }
  if (err instanceof ForbiddenError || isNamed(err, "ForbiddenError")) {
    const reason = (err as ForbiddenError).reason ?? "other";
    if (reason === "select-organization") {
      // The remedy is the choice itself, so this one branch pays to fetch it.
      // A failure to list them degrades to the sentence without a picker,
      // never to a wrong cause.
      const organizations = await resolveMemberships(getAuthForRequest(getRequest(), env), getRequest().headers).catch(
        () => [] as Membership[],
      );
      return { ok: false, kind: "forbidden", reason, error: message(err), organizations };
    }
    return { ok: false, kind: "forbidden", reason, error: message(err) };
  }
  Sentry.captureException(err);
  return { ok: false, kind: "unreachable", error: message(err) };
}

function isNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
