import type { ConnectLinkGrant, GatewayApi } from "@eccos/gateway-contract";
import { createMailSenderFromEnv } from "../auth/config";
import type { MailEnv, MailSender } from "../auth/mail";
import { CONNECT_LINK_API, type LinkOutcome, type LinkStart, type LinkView } from "../lib/connect-link/api";
import { connectAudit, judgeExchange } from "../lib/connect-result";
import { type EmbeddedSignupConfig, embeddedSignupConfig, validateSessionEvent } from "../lib/embedded-signup";
import { type AttemptLimiter, attemptLimiter } from "./attempt-limit";
import { auditEvent } from "./audit";
import { mailLinkOutcome } from "./connect-link-mail";
import { type LinkPeople, linkPeople } from "./connect-link-people";

/**
 * The connection-link landing page's API: the admin-only connect server
 * functions, authenticated by the link token instead of a session.
 *
 * The token is the only credential and the only thing the caller chooses. The
 * account comes from the token's row in the gateway, never from the request,
 * and no answer carries an account, organization or WABA id.
 */

export interface ConnectLinkDeps {
  gateway: Pick<GatewayApi, "resolveConnectLink" | "startConnectForAccountId" | "exchangeConnectCodeForLink">;
  people(organizationId: string, userId: string): Promise<LinkPeople | null>;
  limiter: AttemptLimiter;
  mail: MailSender;
  signup: EmbeddedSignupConfig | null;
  /** The console's own origin, for the link in the outcome mail. */
  origin: string;
}

type Call = { token: string; input: Record<string, unknown>; grant: ConnectLinkGrant; people: LinkPeople; deps: ConnectLinkDeps };

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

function audit(
  grant: ConnectLinkGrant,
  resource: Record<string, string | number | null>,
  outcome: "success" | "denied" | "failed",
  detail?: string,
): void {
  auditEvent({
    action: "connect_link",
    actorUserId: grant.creatorUserId,
    organizationId: grant.organizationId,
    accountId: grant.accountId,
    resource,
    outcome,
    ...(detail ? { detail } : {}),
  });
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new BadRequest();
  return value.trim();
}

class BadRequest extends Error {}

const ACTIONS: Record<string, { gone: unknown; run(call: Call): Promise<unknown> }> = {
  view: {
    gone: { status: "gone", inviter: null } satisfies LinkView,
    async run({ grant, people, deps }): Promise<LinkView> {
      if (grant.state !== "active") return { status: "gone", inviter: people.inviter };
      return {
        status: "ready",
        workspace: people.workspace,
        inviter: people.inviter,
        closed: grant.connectPolicy === "closed",
        signup: deps.signup,
      };
    },
  },
  start: {
    gone: { ok: false, code: "gone" } satisfies LinkStart,
    async run({ grant, deps }): Promise<LinkStart> {
      if (grant.state !== "active") return { ok: false, code: "gone" };
      if (grant.connectPolicy === "closed") {
        audit(grant, { step: "start" }, "denied", "subscription_required");
        return { ok: false, code: "subscription_required" };
      }
      try {
        const started = await deps.gateway.startConnectForAccountId(grant.accountId);
        audit(grant, { step: "start" }, "success");
        return { ok: true, state: started.state };
      } catch {
        audit(grant, { step: "start" }, "failed");
        return { ok: false, code: "failed" };
      }
    },
  },
  exchange: {
    gone: { outcome: "gone" } satisfies LinkOutcome,
    async run({ token, input, people, deps }): Promise<LinkOutcome> {
      const exchange = await deps.gateway.exchangeConnectCodeForLink(token, text(input.code, 4096), text(input.state, 512));
      if (!exchange) return { outcome: "gone" };
      const { grant, result } = exchange;
      const verdict = judgeExchange(result);
      const outcome: LinkOutcome = !verdict.navigate
        ? { outcome: verdict.outcome }
        : verdict.outcome === "ok" && result.ok
          ? { outcome: "connected", phone: result.display_phone_number || null }
          : { outcome: "pending" };
      audit(
        grant,
        result.ok
          ? { step: "exchange", wabaId: result.waba_id, connected: result.connected.length, status: result.status }
          : { step: "exchange", code: result.code },
        connectAudit(result).outcome,
        connectAudit(result).detail,
      );
      if (exchange.notify && outcome.outcome !== "state" && outcome.outcome !== "gone") {
        await mailLinkOutcome(deps.mail, {
          to: people.inviterEmail,
          workspace: people.workspace,
          url: `${deps.origin}/numbers`,
          outcome: outcome.outcome,
          unique: `${grant.accountId}:${Date.now()}`,
        });
      }
      return outcome;
    },
  },
  event: {
    gone: {},
    async run({ input, grant }) {
      const event = validateSessionEvent(input.event);
      auditEvent({
        action: "connect_session_event",
        actorUserId: grant.creatorUserId,
        organizationId: grant.organizationId,
        accountId: grant.accountId,
        resource: {
          via: "connect_link",
          event: event.event,
          currentStep: event.currentStep ?? null,
          errorCode: event.errorCode ?? null,
          sessionId: event.sessionId ?? null,
          wabaId: event.wabaId ?? null,
        },
        outcome: event.errorCode ? "failed" : "success",
      });
      return {};
    },
  },
};

/** `caller` keys the limit on wrong tokens; a right one is never counted. */
export async function handleConnectLink(
  action: string,
  body: unknown,
  caller: string,
  deps: ConnectLinkDeps,
): Promise<Response> {
  const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
  const input = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const token = input.token;
  if (!handler || typeof token !== "string" || token.length > 128) return json({ error: "bad request" }, 400);
  try {
    if (await deps.limiter.blocked(caller)) return json({ error: "too many attempts" }, 429);
    const grant = await deps.gateway.resolveConnectLink(token, action === "view");
    if (!grant) {
      await deps.limiter.strike(caller);
      return json(handler.gone);
    }
    const people = await deps.people(grant.organizationId, grant.creatorUserId);
    if (!people) return json(handler.gone);
    return json(await handler.run({ token, input, grant, people, deps }));
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: "bad request" }, 400);
    // The error's name only: a message could quote its input.
    console.error(
      JSON.stringify({ level: "error", area: "connect-link", action, error: err instanceof Error ? err.name : "unknown" }),
    );
    return json({ error: "unavailable" }, 502);
  }
}

type ConnectLinkEnv = MailEnv & {
  GATEWAY: ConnectLinkDeps["gateway"];
  DB: D1Database;
  META_APP_ID?: string;
  META_ES_CONFIG_ID?: string;
  META_GRAPH_VERSION?: string;
};

/** Null when the request is not for this API. Answered before the session gate: the token is the credential. */
export function connectLinkApi(request: Request, pathname: string, env: ConnectLinkEnv): Promise<Response> | null {
  if (!pathname.startsWith(CONNECT_LINK_API)) return null;
  if (request.method !== "POST") return Promise.resolve(json({ error: "method not allowed" }, 405));
  return request
    .json()
    .catch(() => null)
    .then((body) =>
      handleConnectLink(pathname.slice(CONNECT_LINK_API.length), body, request.headers.get("cf-connecting-ip") ?? "local", {
        gateway: env.GATEWAY,
        people: (organizationId, userId) => linkPeople(env.DB, organizationId, userId),
        limiter: attemptLimiter(env.DB, "connect-link"),
        mail: createMailSenderFromEnv(env),
        signup: embeddedSignupConfig(env),
        origin: new URL(request.url).origin,
      }),
    );
}
