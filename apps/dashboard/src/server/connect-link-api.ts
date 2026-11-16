import type { ConnectLinkGrant, GatewayApi } from "@eccos/gateway-contract";
import { createMailSenderFromEnv } from "../auth/config";
import type { MailEnv, MailSender } from "../auth/mail";
import { CONNECT_LINK_API, type LinkOutcome, type LinkStart, type LinkView } from "../lib/connect-link/api";
import { connectAudit, judgeExchange } from "../lib/connect-result";
import {
  type EmbeddedSignupConfig,
  embeddedSignupConfig,
  validateCodeAndState,
  validateSessionEvent,
} from "../lib/embedded-signup";
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
  gateway: Pick<
    GatewayApi,
    | "resolveConnectLink"
    | "markConnectLinkOpened"
    | "startConnectForAccountId"
    | "claimConnectLink"
    | "exchangeConnectCodeForClaim"
    | "settleConnectLink"
  >;
  people(organizationId: string, userId: string): Promise<LinkPeople | null>;
  /** Wrong tokens per caller. A right token is never counted, so strangers behind one address cannot lock a bearer out. */
  failures: AttemptLimiter;
  /** Session events per caller: each one writes an audit line. */
  events: AttemptLimiter;
  /** States minted per link: each one is a row in the gateway and an audit line. */
  starts: AttemptLimiter;
  mail: MailSender;
  /** Runs work after the response, as `waitUntil` does. */
  defer(work: Promise<unknown>): void;
  signup: EmbeddedSignupConfig | null;
  /** The console's own origin, for the link in the outcome mail. */
  origin: string;
}

type Call = {
  input: Record<string, unknown>;
  caller: string;
  grant: ConnectLinkGrant;
  /** Set for an action that claims, when the link was active and is now held for this request. */
  claimId: string | null;
  people: LinkPeople;
  deps: ConnectLinkDeps;
};

type Action = {
  /** The answer for a token that opens nothing. */
  gone: unknown;
  /** Takes the link for the request instead of only reading it. */
  claims?: true;
  run(call: Call): Promise<unknown>;
};

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

function logFailure(action: string, err: unknown): void {
  // The error's name only: a message could quote its input.
  console.error(
    JSON.stringify({ level: "error", area: "connect-link", action, error: err instanceof Error ? err.name : "unknown" }),
  );
}

class BadRequest extends Error {}
class TooMany extends Error {}

/** A validator's refusal is the caller's mistake: 400, not a failure of ours. */
function accept<T>(validate: () => T): T {
  try {
    return validate();
  } catch {
    throw new BadRequest();
  }
}

/**
 * Runs the exchange under this request's claim and reports how the link was
 * left. An exchange call that dies without an answer may still have registered
 * something, and only this request holds the claim, so it alone may spend the
 * link as unconfirmed; what the gateway had already recorded wins over that.
 */
async function exchange(
  { grant, people, deps }: Call,
  claimId: string,
  code: string,
  state: string,
): Promise<LinkOutcome> {
  let outcome: LinkOutcome;
  let notify: boolean;
  const answered = await deps.gateway.exchangeConnectCodeForClaim(claimId, code, state).catch(() => "lost" as const);
  if (!answered) return { outcome: "gone" };
  if (answered === "lost") {
    const left = await deps.gateway.settleConnectLink(claimId, { kind: "unknown" }).catch(() => null);
    // The link could not be marked either: say what is known, and mail nothing a later result could contradict.
    if (!left) return { outcome: "unknown" };
    outcome =
      left.state === "connected"
        ? { outcome: "connected", phone: null }
        : left.state === "unconfirmed"
          ? { outcome: "unknown" }
          : { outcome: "failed" };
    // The gateway's own "tell the creator" was lost with its answer; the mail's key keeps a repeat harmless.
    notify = outcome.outcome !== "failed";
    audit(grant, { step: "exchange" }, "failed", `lost:${left.state}`);
  } else {
    const { result } = answered;
    const verdict = result && judgeExchange(result);
    outcome =
      !result || !verdict
        ? { outcome: "unknown" }
        : !verdict.navigate
          ? { outcome: verdict.outcome }
          : verdict.outcome === "ok" && result.ok
            ? {
                outcome: "connected",
                phone: result.display_phone_number || null,
                ...(result.subscriptionRequired ? { leftOut: true as const } : {}),
              }
            : { outcome: "pending" };
    notify = answered.notify;
    const logged = result ? connectAudit(result) : { outcome: "failed" as const, detail: "unknown" };
    audit(
      grant,
      !result
        ? { step: "exchange" }
        : result.ok
          ? { step: "exchange", wabaId: result.waba_id, connected: result.connected.length, status: result.status }
          : { step: "exchange", code: result.code },
      logged.outcome,
      logged.detail,
    );
  }
  if (notify && outcome.outcome !== "state" && outcome.outcome !== "gone") {
    const reported = outcome.outcome === "connected" && outcome.leftOut ? "connected_partly" : outcome.outcome;
    deps.defer(
      mailLinkOutcome(deps.mail, {
        to: people.inviterEmail,
        workspace: people.workspace,
        url: `${deps.origin}/numbers`,
        outcome: reported,
        // One mail per link and outcome, whoever asks for it and however often.
        unique: `${grant.linkId}:${reported}`,
      }),
    );
  }
  return outcome;
}

const ACTIONS: Record<string, Action> = {
  view: {
    gone: { status: "gone", inviter: null } satisfies LinkView,
    async run({ grant, people, deps }): Promise<LinkView> {
      if (grant.state !== "active") return { status: "gone", inviter: people.inviter };
      // Only now: the link resolved in full, so "opened" means its reader saw the real page.
      await deps.gateway.markConnectLinkOpened(grant.linkId).catch((err) => logFailure("opened", err));
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
      // Before anything is written or audited: a link cannot be made to mint states without end.
      if (await deps.starts.strike(grant.linkId)) throw new TooMany();
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
    claims: true,
    async run(call): Promise<LinkOutcome> {
      if (!call.claimId) return { outcome: "gone" };
      const { code, state } = validateCodeAndState(call.input);
      return exchange(call, call.claimId, code, state);
    },
  },
  event: {
    gone: {},
    // Only for a link still in use, and only so many: each event is an audit line.
    async run({ input, caller, grant, deps }) {
      const event = accept(() => validateSessionEvent(input.event));
      if (grant.state !== "active" || (await deps.events.strike(caller))) return {};
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

/** `caller` keys the limits. The token is checked first: only a wrong one can be refused for trying too often. */
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
  let claimId: string | null = null;
  try {
    let grant: ConnectLinkGrant | null;
    if (handler.claims) {
      // Checked before the link is taken, so a malformed request holds nothing.
      accept(() => validateCodeAndState(input));
      let claimed: Awaited<ReturnType<ConnectLinkDeps["gateway"]["claimConnectLink"]>>;
      try {
        claimed = await deps.gateway.claimConnectLink(token);
      } catch (err) {
        // Nothing was claimed, so nothing ran: the same link can simply be tried again.
        logFailure(action, err);
        return json({ outcome: "failed" } satisfies LinkOutcome);
      }
      if (claimed === "busy") return json({ outcome: "busy" } satisfies LinkOutcome);
      grant = claimed?.grant ?? null;
      claimId = claimed?.claimId ?? null;
    } else {
      grant = await deps.gateway.resolveConnectLink(token);
    }
    if (!grant) {
      return (await deps.failures.strike(caller)) ? json({ error: "too many attempts" }, 429) : json(handler.gone);
    }
    const people = await deps.people(grant.organizationId, grant.creatorUserId);
    if (!people) {
      if (claimId) await deps.gateway.settleConnectLink(claimId, { kind: "released" });
      return json(handler.gone);
    }
    return json(await handler.run({ input, caller, grant, claimId, people, deps }));
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: "bad request" }, 400);
    if (err instanceof TooMany) return json({ error: "too many attempts" }, 429);
    logFailure(action, err);
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

const MINUTE_MS = 60 * 1000;

/** Null when the request is not for this API. Answered before the session gate: the token is the credential. */
export function connectLinkApi(
  request: Request,
  pathname: string,
  env: ConnectLinkEnv,
  defer: ConnectLinkDeps["defer"],
): Promise<Response> | null {
  if (!pathname.startsWith(CONNECT_LINK_API)) return null;
  if (request.method !== "POST") return Promise.resolve(json({ error: "method not allowed" }, 405));
  return request
    .json()
    .catch(() => null)
    .then((body) =>
      handleConnectLink(pathname.slice(CONNECT_LINK_API.length), body, request.headers.get("cf-connecting-ip") ?? "local", {
        gateway: env.GATEWAY,
        people: (organizationId, userId) => linkPeople(env.DB, organizationId, userId),
        failures: attemptLimiter(env.DB, "connect-link", 10, 10 * MINUTE_MS),
        events: attemptLimiter(env.DB, "connect-link-event", 120, 10 * MINUTE_MS),
        starts: attemptLimiter(env.DB, "connect-link-start", 5, MINUTE_MS),
        mail: createMailSenderFromEnv(env),
        defer,
        signup: embeddedSignupConfig(env),
        origin: new URL(request.url).origin,
      }),
    );
}
