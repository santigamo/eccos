import type { IssuedSecretClaim } from "@eccos/gateway-contract";
import { z } from "zod";
import { offer } from "./next";
import { type McpActor, ToolError, type ToolDeps } from "./registry";
import { isoTime } from "./scope";

/** The console's claim page and API (design § 3.6, contract § 10). */
const CLAIM_PAGE = "/claim";
const CLAIM_API = "/api/claim";

/** What a claim delivers, and the variable its command writes. */
const SECRETS = {
  api_key: {
    variable: "ECCOS_API_KEY",
    message:
      "The API key has not been shown to you. Run the command to write it where it belongs, or give the link to a person. The claim works once and expires in 10 minutes; until it is claimed, no key exists.",
  },
  subscriber_secret: {
    variable: "ECCOS_WEBHOOK_SECRET",
    message:
      "The signing secret has not been shown to you. Run the command to write it where your webhook receiver reads it, or give the link to a person. The claim works once and expires in 10 minutes; until it is claimed, no new secret exists and forwards are signed as before (or not at all, if no secret was set).",
  },
} as const;

/** The design § 3.6 claim result's fields besides its status. The secret is never among them. */
export const claimFields = {
  message: z
    .string()
    .describe(
      "What to do with the claim. The secret itself is never in this result.",
    ),
  claimUrl: z
    .string()
    .describe(
      "A page where a person reveals the secret once. Give it to a person; a link preview does not spend it.",
    ),
  command: z
    .string()
    .describe(
      "A shell command that redeems the claim and appends the secret to .env, so the secret never passes through you. Run it as is.",
    ),
  expiresAt: z.string().describe("When the claim stops working, ISO time."),
};

/** POSIX single quotes: the value cannot break out of the argument. */
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function claimReady(
  consoleOrigin: string,
  kind: keyof typeof SECRETS,
  claim: IssuedSecretClaim,
) {
  const { variable, message } = SECRETS[kind];
  const api = quoted(`${consoleOrigin}${CLAIM_API}`);
  const body = quoted(`token=${claim.token}`);
  return {
    status: "claim_ready" as const,
    message,
    // In the fragment, so the token reaches no server log and no Referer.
    claimUrl: `${consoleOrigin}${CLAIM_PAGE}#${claim.token}`,
    // A POST with the token in the body; a refused claim writes nothing to .env.
    command: `secret="$(curl -fsS -X POST ${api} --data-urlencode ${body})" && printf '${variable}=%s\\n' "$secret" >> .env && unset secret`,
    expiresAt: isoTime(claim.expiresAt) as string,
  };
}

/** The gateway holds at most 20 unclaimed secrets per account. */
export const tooManyPending = (
  deps: ToolDeps,
  actor: McpActor,
  before: string,
) =>
  new ToolError(
    offer(
      deps,
      actor,
      `${before} This workspace already has 20 unclaimed secrets, the most Eccos holds; each works once and expires 10 minutes after it was made, so try again once one is claimed or has expired.`,
      {
        tool: "api_keys_list",
        call: "Call api_keys_list to see them under pendingClaims, with when each expires.",
      },
    ).detail,
    "too_many_pending",
  );
