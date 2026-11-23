import type { SetSubscriberConfigInput } from "@eccos/gateway-contract";
import { z } from "zod";
import { claimFields, claimReady, tooManyPending } from "./claim";
import { offer } from "./next";
import { ToolError, defineTool } from "./registry";
import { isoTime, ownedWaba, wabaIdInput } from "./scope";

/** The gateway's closed reasons for refusing a target URL (validateSubscriberUrl). */
const URL_REFUSALS = [
  "must not be empty",
  "must be a valid URL",
  "must use https",
  "credentials are not allowed",
  "private hosts are not allowed",
];

/** The gateway's refusal of a URL as something the agent can fix; any other failure stays opaque. */
function refusedUrl(error: unknown): ToolError | null {
  const message = error instanceof Error ? error.message : "";
  const reason = URL_REFUSALS.find((candidate) =>
    message.includes(`invalid subscriber URL: ${candidate}`),
  );
  if (!reason) return null;
  return new ToolError(
    `Eccos refused the URL: it ${reason}. Forwarding needs a public https URL without a user name or password. Fix it and call webhook_set again.`,
    "invalid_url",
  );
}

export const webhookGet = defineTool({
  name: "webhook_get",
  action: "operate",
  stepUp: false,
  title: "Get the webhook target",
  description: [
    "Returns where Eccos forwards a WhatsApp Business account's (WABA) incoming events: the subscriber URL, whether a signing secret is set,",
    "and the last forward (its status, attempts, times and last error). The signing secret itself is never returned, to anyone.",
    "Use it before webhook_set, or to see why events are not arriving. It changes nothing.",
  ].join(" "),
  inputSchema: z.object({ wabaId: wabaIdInput }),
  outputSchema: z.object({
    wabaId: z.string(),
    url: z
      .string()
      .nullable()
      .describe(
        "Where events are forwarded; null when no target is set and events wait in the queue.",
      ),
    hasSecret: z
      .boolean()
      .describe("Whether forwards carry an x-eccos-signature header."),
    lastForward: z
      .object({
        status: z.string(),
        attempts: z.number(),
        createdAt: z.string().describe("When the event arrived."),
        finishedAt: z
          .string()
          .nullable()
          .describe(
            "When the forward finished; null while it is queued or retrying.",
          ),
        lastError: z.string().nullable(),
      })
      .nullable(),
    detail: z.string(),
    nextTool: z.string().nullable(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: async (input, actor, deps) => {
    const { gateway } = deps.for("operate");
    const waba = await ownedWaba(deps, actor, input.wabaId);
    const config = await gateway.getSubscriberConfig(
      waba.wabaId,
      actor.accountId,
    );
    const last = config.lastForward;
    const fact =
      config.url === null
        ? "No webhook target is set, so incoming events wait in the queue."
        : config.hasSecret
          ? "Events are forwarded to this URL, signed in the x-eccos-signature header."
          : "Events are forwarded to this URL unsigned: no signing secret is set.";
    const next =
      config.url === null
        ? {
            tool: "webhook_set" as const,
            call: "Call webhook_set with the URL that should receive them.",
          }
        : config.hasSecret
          ? undefined
          : {
              tool: "webhook_set" as const,
              call: 'Call webhook_set with secret: "generate" to have them signed.',
            };
    return {
      wabaId: waba.wabaId,
      url: config.url,
      hasSecret: config.hasSecret,
      lastForward: last && {
        status: last.status,
        attempts: last.attempts,
        createdAt: isoTime(last.createdAt) as string,
        finishedAt: isoTime(last.finishedAt),
        lastError: last.lastError,
      },
      ...offer(deps, actor, fact, next),
    };
  },
});

export const webhookSet = defineTool({
  name: "webhook_set",
  action: "configure",
  stepUp: true,
  title: "Set the webhook target",
  description: [
    "Sets the public https URL where Eccos forwards a WhatsApp Business account's (WABA) incoming events, and its signing secret,",
    "which Eccos uses to sign each forward in the x-eccos-signature header. The URL applies at once.",
    'secret: "keep" (the default) leaves the stored secret as it is; "remove" deletes it, so forwards go unsigned;',
    '"generate" makes a new secret delivered by a one-time claim: the result has status claim_ready, a command that writes ECCOS_WEBHOOK_SECRET',
    "to .env and a link for a person. You never see the secret, and the previous one stays in force until the claim is redeemed.",
    "Instead of secret, secretValue stores a secret the customer's receiver already uses; that value then passes through you and your model",
    'provider, so prefer "generate" unless the receiver cannot change its secret.',
  ].join(" "),
  inputSchema: z.object({
    wabaId: wabaIdInput,
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .describe("The public https URL that receives the events."),
    secret: z
      .enum(["generate", "keep", "remove"])
      .optional()
      .describe(
        'What to do with the signing secret. Default "keep". Leave it out when you pass secretValue.',
      ),
    secretValue: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'A signing secret the customer\'s receiver already uses. It passes through you; prefer secret: "generate".',
      ),
  }),
  outputSchema: z.object({
    status: z.enum(["saved", "claim_ready"]),
    wabaId: z.string(),
    url: z.string(),
    secret: z
      .enum(["kept", "removed", "replaced", "claim_pending"])
      .describe(
        "What happened to the signing secret; claim_pending means the new one exists once the claim is redeemed.",
      ),
    message: claimFields.message,
    claimUrl: claimFields.claimUrl.optional(),
    command: claimFields.command.optional(),
    expiresAt: claimFields.expiresAt.optional(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  audit: (input) => ({
    wabaId: input.wabaId ?? null,
    secret:
      input.secretValue === undefined ? (input.secret ?? "keep") : "value",
  }),
  run: async (input, actor, deps, trail) => {
    if (input.secret !== undefined && input.secretValue !== undefined) {
      throw new ToolError(
        "Pass either secret or secretValue, not both. Call webhook_set again with one of them.",
      );
    }
    const { gateway } = deps.for("configure");
    const waba = await ownedWaba(deps, actor, input.wabaId);
    trail.note({ wabaId: waba.wabaId });
    const mode =
      input.secretValue === undefined ? (input.secret ?? "keep") : "value";
    // The console's SetSubscriberConfigInput: an omitted secret keeps the stored one, null removes it.
    const write: SetSubscriberConfigInput =
      mode === "remove"
        ? { url: input.url, secret: null }
        : mode === "value"
          ? { url: input.url, secret: input.secretValue }
          : { url: input.url };
    try {
      await gateway.setSubscriberConfig(write, waba.wabaId, actor.accountId);
    } catch (error) {
      throw refusedUrl(error) ?? error;
    }
    if (mode === "generate") {
      const claim = await gateway.createSecretClaim(
        actor.accountId,
        { kind: "subscriber_secret", wabaId: waba.wabaId },
        { userId: actor.userId, clientId: actor.clientId },
      );
      if (claim === "too_many_pending") {
        throw tooManyPending(
          deps,
          actor,
          `The URL was saved, but no new signing secret was made, so forwards are signed as before.`,
        );
      }
      trail.note({ claimId: claim.claimId });
      const ready = claimReady(deps.consoleOrigin, "subscriber_secret", claim);
      return {
        ...ready,
        wabaId: waba.wabaId,
        url: input.url,
        secret: "claim_pending" as const,
      };
    }
    const outcome = {
      keep: "kept",
      remove: "removed",
      value: "replaced",
    } as const;
    const said = {
      keep: "The signing secret is unchanged.",
      remove: "The signing secret was removed: forwards now go unsigned.",
      value: "The signing secret was replaced with the value you passed.",
    };
    return {
      status: "saved" as const,
      wabaId: waba.wabaId,
      url: input.url,
      secret: outcome[mode],
      message: `Saved: events are forwarded to ${input.url}. ${said[mode]}`,
    };
  },
});

export const webhookResubscribe = defineTool({
  name: "webhook_resubscribe",
  action: "configure",
  stepUp: true,
  title: "Redo the Meta webhook subscription",
  description: [
    "Asks Meta again to send this WhatsApp Business account's (WABA) events to Eccos. Use it when status_get or the person reports that",
    "messages stopped arriving at Eccos itself; it does not change where Eccos forwards them (that is webhook_set). Works on an active WABA;",
    "for one still being set up, call number_recheck instead. Safe to repeat.",
  ].join(" "),
  inputSchema: z.object({ wabaId: wabaIdInput }),
  outputSchema: z.object({
    status: z.literal("resubscribed"),
    wabaId: z.string(),
    message: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  audit: (input) => ({ wabaId: input.wabaId ?? null }),
  run: async (input, actor, deps, trail) => {
    const { gateway } = deps.for("configure");
    const waba = await ownedWaba(deps, actor, input.wabaId);
    trail.note({ wabaId: waba.wabaId });
    // The console resubscribes only an active WABA (withScopedGateway's default scope).
    if (waba.status !== "active") {
      throw new ToolError(
        offer(
          deps,
          actor,
          `WABA ${waba.wabaId} is ${waba.status}, not active, so there is no subscription to redo.`,
          {
            tool: "number_recheck",
            call: "Call number_recheck to finish its setup, which subscribes it.",
          },
        ).detail,
      );
    }
    const result = await gateway.resubscribe(waba.wabaId, actor.accountId);
    if (!result.ok) {
      throw new ToolError(
        `Meta did not accept the subscription for WABA ${waba.wabaId} just now. Call webhook_resubscribe again in a few minutes; if it keeps failing, the person should contact Eccos support.`,
        "resubscribe_failed",
      );
    }
    return {
      status: "resubscribed" as const,
      wabaId: waba.wabaId,
      message: `Meta confirmed that WABA ${waba.wabaId} sends its events to Eccos.`,
    };
  },
});
