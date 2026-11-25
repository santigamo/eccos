import type { GatewayApi } from "@eccos/gateway-contract";
import type { FunnelMailInput, FunnelMailResult } from "@eccos/gateway-contract/funnel-mail";
import { LOCAL_ORIGIN } from "../auth/config";
import { ConsoleMailSender, deriveIdempotencyKey, MailProviderError, type MailSender, type MailTemplate } from "../auth/mail";
import { ReccadoMailSender } from "../auth/mail-reccado";

/** A ledger row's kind: the gateway's four, plus the console's own recovery email. */
export type FunnelKind = FunnelMailInput["kind"] | "recovery";

export interface FunnelDeps {
  db: D1Database;
  mail: MailSender;
  gateway: Pick<GatewayApi, "getOrganizationAccountLink" | "listAccountResources" | "getAccountBilling">;
  /** The console origin every link points at. */
  origin: string;
  now?: () => number;
}

export interface FunnelMailEnv {
  BETTER_AUTH_URL?: string;
  /** Worker secrets: a reccado key whose sending identity is Santi, so replies reach him. */
  FUNNEL_RECCADO_API_KEY?: string;
  FUNNEL_RECCADO_ENDPOINT?: string;
}

/**
 * Real mail only from a production console (an https origin) with the funnel
 * key configured. Everywhere else the console sender only logs, so development
 * and tests never reach a real address.
 */
export function funnelMailSender(env: FunnelMailEnv): MailSender {
  const production = env.BETTER_AUTH_URL?.trim().startsWith("https://");
  if (!production || !env.FUNNEL_RECCADO_API_KEY?.trim()) return new ConsoleMailSender();
  return new ReccadoMailSender({ RECCADO_API_KEY: env.FUNNEL_RECCADO_API_KEY, RECCADO_ENDPOINT: env.FUNNEL_RECCADO_ENDPOINT });
}

export function funnelDeps(env: Cloudflare.Env): FunnelDeps {
  return {
    db: env.DB,
    mail: funnelMailSender(env),
    gateway: env.GATEWAY,
    origin: env.BETTER_AUTH_URL?.trim() || LOCAL_ORIGIN,
  };
}

export const NUMBERS_PATH = "/numbers";
/** The billing page (eccos-dbb3.7), where the subscription starts. */
export const SUBSCRIBE_PATH = "/billing";

/** Customers are Spanish small businesses; the copy names a wall-clock time without a zone. */
const TIME_ZONE = "Europe/Madrid";
const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TIME_ZONE });
const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: TIME_ZONE });
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TIME_ZONE });

/** "Sat 28 Nov" */
export const formatDay = (ms: number) => day.format(ms).replace(",", "");
/** "10:42" */
export const formatTime = (ms: number) => clock.format(ms);
/** "Sat 28 Nov at 10:42" */
export const formatMoment = (ms: number) => `${formatDay(ms)} at ${formatTime(ms)}`;

const MAY_RECEIVE = new Set(["owner", "admin"]);

export interface Recipient {
  email: string;
  name: string;
}

/** The workspace's owners and admins with a verified address. */
export async function funnelRecipients(db: D1Database, organizationId: string): Promise<Recipient[]> {
  const { results } = await db
    .prepare(
      `SELECT u."email" AS email, u."name" AS name, m."role" AS role
       FROM "member" m JOIN "user" u ON u."id" = m."userId"
       WHERE m."organizationId" = ? AND u."emailVerified" = 1`,
    )
    .bind(organizationId)
    .all<{ email: string; name: string; role: string }>();
  return results
    .filter((row) => row.role.split(",").some((role) => MAY_RECEIVE.has(role.trim())))
    .map((row) => ({ email: row.email, name: row.name.trim().split(/\s+/)[0] || "there" }));
}

interface Composed {
  template: MailTemplate;
  variables: Record<string, string>;
}

function compose(input: FunnelMailInput, phone: string, origin: string): Composed {
  const subscribe = new URL(SUBSCRIBE_PATH, origin).href;
  switch (input.kind) {
    case "activated":
      return {
        template: "funnel-activated",
        variables: {
          first_message:
            input.via === "webhook"
              ? `Your first message reached your tool through Eccos today at ${formatTime(input.activatedAt)}.`
              : `Your first message went through Eccos today at ${formatTime(input.activatedAt)}.`,
          phone,
          window_ends: formatMoment(input.windowEndsAt),
          url: subscribe,
        },
      };
    case "window_ending":
      return { template: "funnel-window-ending", variables: { window_ends: formatMoment(input.windowEndsAt), url: subscribe } };
    case "paused":
      return {
        template: "funnel-paused",
        variables: {
          opening:
            input.reason === "window_ended"
              ? `Your setup window ended today at ${formatTime(input.pausedAt)}, so ${phone} is paused.`
              : `No message has gone through ${phone} in the 14 days since you connected it, so it is paused.`,
          url: subscribe,
        },
      };
    case "never_activated_warning":
      return {
        template: "funnel-never-activated",
        variables: {
          phone,
          connected_on: date.format(input.connectedAt),
          pauses_on: formatDay(input.pausesAt),
          url: new URL(NUMBERS_PATH, origin).href,
        },
      };
  }
}

/** The two warnings go stale once the account subscribes; the others are facts that already happened. */
const ONLY_UNSUBSCRIBED = new Set<FunnelKind>(["window_ending", "never_activated_warning"]);

/** What the gateway calls (eccos-dbb3.2). Idempotent per account and kind. */
export async function sendFunnelEmail(deps: FunnelDeps, input: FunnelMailInput): Promise<FunnelMailResult> {
  const link = await deps.gateway.getOrganizationAccountLink(input.organizationId);
  if (!link || link.status !== "active" || link.accountId !== input.accountId) {
    return { status: "skipped", reason: "not_linked" };
  }
  if (ONLY_UNSUBSCRIBED.has(input.kind)) {
    const billing = await deps.gateway.getAccountBilling(input.accountId);
    if (billing && billing.billingStatus !== "setup") return { status: "skipped", reason: "subscribed" };
  }
  const { phones } = await deps.gateway.listAccountResources(input.accountId);
  const { template, variables } = compose(input, phones[0]?.displayPhoneNumber ?? "your number", deps.origin);
  return deliver(deps, { accountId: input.accountId, organizationId: input.organizationId, kind: input.kind }, template, variables);
}

/**
 * Sends one funnel email to every recipient, once per account and kind.
 *
 * The ledger row settles only after every send returned, so a throw leaves it
 * open for the next call; the provider's Idempotency-Key, derived from the
 * account and stable across calls, keeps the recipients already mailed from a
 * second copy, and a 409 (same key, a payload that moved, e.g. a renamed user)
 * means that one was mailed too.
 */
export async function deliver(
  deps: FunnelDeps,
  row: { accountId: string; organizationId: string; kind: FunnelKind },
  template: MailTemplate,
  variables: Record<string, string>,
): Promise<FunnelMailResult> {
  const now = deps.now?.() ?? Date.now();
  await deps.db
    .prepare(
      `INSERT INTO "funnelMail" ("accountId", "kind", "organizationId", "dueAt") VALUES (?, ?, ?, ?)
       ON CONFLICT ("accountId", "kind") DO NOTHING`,
    )
    .bind(row.accountId, row.kind, row.organizationId, now)
    .run();
  const ledger = await deps.db
    .prepare(`SELECT "settledAt" FROM "funnelMail" WHERE "accountId" = ? AND "kind" = ?`)
    .bind(row.accountId, row.kind)
    .first<{ settledAt: number | null }>();
  if (ledger?.settledAt != null) return { status: "duplicate" };

  const recipients = await funnelRecipients(deps.db, row.organizationId);
  for (const to of recipients) {
    try {
      await deps.mail.sendTemplate({
        template,
        to: to.email,
        variables: { name: to.name, ...variables },
        idempotencyKey: await deriveIdempotencyKey(template, to.email, row.accountId),
      });
    } catch (err) {
      if (!(err instanceof MailProviderError && err.kind === "idempotency_conflict")) throw err;
    }
  }
  await settle(deps.db, row.accountId, row.kind, now);
  return recipients.length ? { status: "sent", recipients: recipients.length } : { status: "skipped", reason: "no_recipients" };
}

export async function settle(db: D1Database, accountId: string, kind: FunnelKind, at: number): Promise<void> {
  await db
    .prepare(`UPDATE "funnelMail" SET "settledAt" = ? WHERE "accountId" = ? AND "kind" = ?`)
    .bind(at, accountId, kind)
    .run();
}
