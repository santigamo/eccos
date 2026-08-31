import type { Failure } from "../server/gateway";

/**
 * What the console says about a `{ ok: false }` (eccos-k5a).
 *
 * One mapping, keyed on the failure's `kind` / `reason` — the codes the server
 * boundary set from the thrown error's TYPE. Nothing here reads
 * `failure.error`, so no screen can drift back into guessing a cause from a
 * message: an authorization refusal never claims the gateway is down, and the
 * gateway is only blamed when the transport actually failed.
 *
 * Type-only import, so this module stays free of `cloudflare:workers` and can
 * be exercised directly under plain `bun test`.
 */
export interface FailureCopy {
  /** What happened, in the console's own words. */
  title: string;
  /** One sentence: what it means, and what the operator can do next. */
  detail: string;
}

export function failureCopy(failure: Failure): FailureCopy {
  if (failure.kind === "unauthenticated") {
    return {
      title: "Signed out",
      detail: "This session is no longer signed in. Sign in again to continue.",
    };
  }
  if (failure.kind === "forbidden") {
    return forbiddenCopy(failure);
  }
  // Transport or RPC failure: the one case where blaming the gateway is a
  // statement of fact, so the underlying message is the detail.
  return { title: "Gateway unreachable", detail: failure.error };
}

function forbiddenCopy(failure: Failure): FailureCopy {
  switch (failure.reason) {
    case "no-organization":
      return {
        title: "No workspace yet",
        detail:
          "This account does not belong to a workspace. Create one to connect a WhatsApp number, or ask an admin to invite you to theirs.",
      };
    case "select-organization":
      return {
        title: "Choose a workspace",
        detail:
          "You belong to more than one workspace and none is selected for this session. Pick the one you want to work in.",
      };
    case "not-a-member":
      return {
        title: "Not your workspace",
        detail:
          "This session is not a member of the workspace it asked for. Sign in with the account that belongs to it, or ask an admin for an invitation.",
      };
    case "missing-permission":
      // Worded to serve both a whole page and a single refused action, since
      // the same mapping backs the inline notices.
      return {
        title: "Not available to your role",
        detail:
          "Your role in this workspace does not allow this. Ask an owner or an admin to widen it.",
      };
    default:
      // A refusal with no reason code of its own: report it as the refusal it
      // is, using the server's own words rather than inventing a cause.
      return { title: "Not allowed", detail: failure.error };
  }
}
