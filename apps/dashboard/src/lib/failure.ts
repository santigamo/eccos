import type { CreateTemplateFailureCode, Failure, SendTestFailureCode } from "../server/gateway";

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

/**
 * What the console says about a refused template test send.
 *
 * Same discipline as {@link failureCopy}: keyed on the closed
 * `SendTestFailureCode` the gateway decided, never on Meta's message text. The
 * `detail` is Graph's own sentence and is only ever shown as a secondary line —
 * it explains, it never discriminates.
 */
export function sendTestFailureCopy(
  code: SendTestFailureCode,
  detail: string | null,
): FailureCopy {
  switch (code) {
    case "rate_limited":
      return {
        title: "Send limit reached",
        detail:
          "This workspace has hit its send rate limit. The limit is shared with the API, so wait a moment and try again.",
      };
    case "no_phone":
      return {
        title: "Number no longer available",
        detail:
          "That number is not registered on this WhatsApp Business account any more. Reload the page and pick another.",
      };
    case "recipient_not_allowlisted":
      // The single most likely failure during App Review filming, and the one
      // Meta's own error text explains worst.
      return {
        title: "Recipient not allowed",
        detail:
          "This recipient is not on the test number's allowed list. Add it under WhatsApp > API Setup in the Meta App Dashboard and try again.",
      };
    case "template_not_found":
      return {
        title: "Template not available",
        detail:
          "Meta has no approved translation of this template for the language selected. Check its status in WhatsApp Manager.",
      };
    case "parameter_mismatch":
      return {
        title: "Parameters do not match",
        detail:
          "Meta expected different parameters for this template. Its approved content may have changed since this page loaded.",
      };
    default:
      return {
        title: "Meta refused the send",
        detail: detail ?? "Meta refused the message without saying why.",
      };
  }
}

/**
 * What the console says about a refused template creation.
 *
 * Same discipline as {@link sendTestFailureCopy}: keyed on the closed
 * `CreateTemplateFailureCode` the gateway decided, never on Meta's message
 * text, which only ever appears as a secondary line.
 */
export function createTemplateFailureCopy(
  code: CreateTemplateFailureCode,
  detail: string | null,
): FailureCopy {
  switch (code) {
    case "name_taken":
      // Deliberately not worded around the 30-day post-deletion name lock:
      // Meta answers with the same subcode for a template that simply exists,
      // and for one whose name is still locked. This sentence is true of both
      // without claiming which one happened.
      return {
        title: "Name already in use",
        detail:
          "A template with this name already exists in this language. Pick another name, or manage the existing one in WhatsApp Manager.",
      };
    case "invalid":
      return {
        title: "Meta refused the template",
        detail:
          "Something in the name, language, or body does not meet Meta's format rules.",
      };
    case "rate_limited":
      return {
        title: "Creation limit reached",
        detail:
          "Meta is rate-limiting template creation for this account. Wait a few minutes and try again.",
      };
    default:
      return {
        title: "Meta refused the template",
        detail: detail ?? "Meta refused the template without saying why.",
      };
  }
}
