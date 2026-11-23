import { z } from "zod";
import { claimFields, claimReady, tooManyPending } from "./claim";
import { offer } from "./next";
import { ToolError, defineTool } from "./registry";
import { isoTime } from "./scope";

/** The console's key label rule (validateIssueKeyInput). */
const MAX_LABEL_LENGTH = 200;
/** The control plane's key ids: `key_` and a UUID's hex. Never a key itself, so it is safe in an audit line. */
const KEY_ID_PATTERN = /^key_[A-Za-z0-9]{1,64}$/;

export const apiKeysList = defineTool({
  name: "api_keys_list",
  action: "administer",
  reads: [],
  stepUp: false,
  title: "List API keys and pending claims",
  description: [
    "Lists this workspace's API keys for the /v1 API (id, label, created and revoked times) and its pending claims: secrets made by",
    "api_key_create or webhook_set that nobody has claimed yet, with when each expires. A key's value is never shown again after it is",
    "issued, and a claim's link is not listed. A key you made by claim appears here once it is claimed. It changes nothing.",
  ].join(" "),
  inputSchema: z.object({}),
  outputSchema: z.object({
    keys: z.array(
      z.object({
        keyId: z.string(),
        label: z.string().nullable(),
        createdAt: z.string(),
        revokedAt: z.string().nullable(),
      }),
    ),
    pendingClaims: z.array(
      z.object({
        kind: z
          .enum(["api_key", "subscriber_secret"])
          .describe(
            "api_key from api_key_create, subscriber_secret from webhook_set.",
          ),
        label: z.string().nullable(),
        wabaId: z.string().nullable(),
        createdAt: z.string(),
        expiresAt: z.string(),
        createdByYou: z
          .boolean()
          .describe(
            "Whether the person this agent acts for made it, through any agent.",
          ),
      }),
    ),
    detail: z.string(),
    nextTool: z.string().nullable(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: async (_input, actor, deps) => {
    const { gateway } = deps.for("administer");
    const [keys, claims] = await Promise.all([
      gateway.listApiKeys(actor.accountId),
      gateway.listSecretClaims(actor.accountId),
    ]);
    const active = keys.filter((key) => key.revokedAt === null).length;
    const fact = `${active} active ${active === 1 ? "key" : "keys"}, ${keys.length - active} revoked, ${claims.length} pending ${claims.length === 1 ? "claim" : "claims"}.`;
    return {
      keys: keys.map((key) => ({
        keyId: key.keyId,
        label: key.label,
        createdAt: isoTime(key.createdAt) as string,
        revokedAt: isoTime(key.revokedAt),
      })),
      pendingClaims: claims.map((claim) => ({
        kind: claim.kind,
        label: claim.kind === "api_key" ? claim.label : null,
        wabaId: claim.kind === "subscriber_secret" ? claim.wabaId : null,
        createdAt: isoTime(claim.createdAt) as string,
        expiresAt: isoTime(claim.expiresAt) as string,
        createdByYou: claim.creatorUserId === actor.userId,
      })),
      ...offer(
        deps,
        actor,
        fact,
        active === 0
          ? {
              tool: "api_key_create",
              call: "Call api_key_create to make one for the /v1 API.",
            }
          : undefined,
      ),
    };
  },
});

export const apiKeyCreate = defineTool({
  name: "api_key_create",
  action: "administer",
  reads: [],
  stepUp: true,
  title: "Create an API key",
  description: [
    "Makes an API key for this workspace's /v1 API. By default it is delivered by a one-time claim: the result has status claim_ready,",
    "a command that writes ECCOS_API_KEY to .env and a link for a person, so the key never passes through you. Run the command (or give the",
    "link to a person); the claim works once and expires in 10 minutes, and until it is claimed no key exists.",
    'delivery: "inline" issues the key at once and returns it in this result instead: the key then sits in your context and is sent to your',
    "model provider. Prefer the claim; use inline only when you can neither run a command nor hand a link to a person.",
  ].join(" "),
  inputSchema: z.object({
    label: z
      .string()
      .trim()
      .max(MAX_LABEL_LENGTH)
      .optional()
      .describe(
        'A name for the key, shown in api_keys_list, e.g. "production server".',
      ),
    delivery: z
      .enum(["claim", "inline"])
      .default("claim")
      .describe(
        '"claim" (the default) keeps the key out of your context; "inline" returns it to you.',
      ),
  }),
  outputSchema: z.object({
    status: z.enum(["claim_ready", "issued"]),
    message: claimFields.message,
    claimUrl: claimFields.claimUrl.optional(),
    command: claimFields.command.optional(),
    expiresAt: claimFields.expiresAt.optional(),
    keyId: z.string().optional().describe("Only with delivery inline."),
    apiKey: z
      .string()
      .optional()
      .describe("Only with delivery inline: the key, shown this once."),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  audit: (input) => ({ delivery: input.delivery }),
  run: async (input, actor, deps, trail) => {
    const { gateway } = deps.for("administer");
    const label = input.label || undefined;
    if (input.delivery === "inline") {
      const issued = await gateway.issueApiKey(actor.accountId, label);
      trail.note({ keyId: issued.keyId });
      return {
        status: "issued" as const,
        message:
          "This is the only time the key is shown. Store it where the /v1 client reads it (for example ECCOS_API_KEY in .env), send it as Authorization: Bearer <key>, and do not repeat it in the conversation.",
        keyId: issued.keyId,
        apiKey: issued.apiKey,
      };
    }
    const claim = await gateway.createSecretClaim(
      actor.accountId,
      { kind: "api_key", ...(label ? { label } : {}) },
      { userId: actor.userId, clientId: actor.clientId },
    );
    if (claim === "too_many_pending")
      throw tooManyPending(deps, actor, "No key and no claim was made.");
    trail.note({ claimId: claim.claimId });
    return claimReady(deps.consoleOrigin, "api_key", claim);
  },
});

export const apiKeyRevoke = defineTool({
  name: "api_key_revoke",
  action: "administer",
  reads: [],
  stepUp: true,
  title: "Revoke an API key",
  description: [
    "Revokes one of this workspace's API keys at once: every /v1 call with it is refused from then on, and it cannot be restored.",
    "Take keyId from api_keys_list. Revoke a key when it leaked, or when a claim you made answered that it was already claimed by someone else.",
  ].join(" "),
  inputSchema: z.object({
    keyId: z
      .string()
      .trim()
      .regex(KEY_ID_PATTERN, "a key id from api_keys_list, like key_…")
      .describe(
        "The key's id from api_keys_list (key_…), never the key itself.",
      ),
  }),
  outputSchema: z.object({
    status: z.literal("revoked"),
    keyId: z.string(),
    message: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  audit: (input) => ({ keyId: input.keyId }),
  run: async (input, actor, deps) => {
    const { gateway } = deps.for("administer");
    if (!(await gateway.revokeApiKey(actor.accountId, input.keyId))) {
      throw new ToolError(
        offer(
          deps,
          actor,
          `This workspace has no active key ${input.keyId}: it may be revoked already.`,
          {
            tool: "api_keys_list",
            call: "Call api_keys_list to see its keys.",
          },
        ).detail,
        "not_found",
      );
    }
    return {
      status: "revoked" as const,
      keyId: input.keyId,
      message: `Key ${input.keyId} is revoked: the /v1 API refuses it from now on.`,
    };
  },
});
