import type {
  CreateTemplateFailureCode,
  Failure,
  ManualConnectFailureCode,
  SendTestFailureCode,
} from "../server/gateway";

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

/**
 * What the console says about a refused pasted-token connection (eccos-up9).
 *
 * Same discipline as {@link sendTestFailureCopy}: keyed on the closed
 * `ManualConnectFailureCode` the gateway decided, never on Meta's message text.
 *
 * The `foreign_app` sentence is the one that carries the whole design of this
 * surface. The form is honest rather than hidden — no deployment flag can tell
 * a workable token from an unworkable one, because workability is a property of
 * the TOKEN — so the operator who cannot use it learns that here, in the
 * console's own words, together with the flow that does work for them.
 *
 * `no_access` and `no_phone` only ever follow an id the operator supplied;
 * `no_waba` never does — the panel relies on that to know when to ask and when
 * not to ask again.
 */
export function tokenConnectFailureCopy(
  code: ManualConnectFailureCode,
  detail: string | null,
): FailureCopy {
  switch (code) {
    case "foreign_app":
      return {
        title: "Another app issued this token",
        detail:
          "Meta only lets an app inspect the tokens it issued itself, and this one came from a different app. To connect a number your business owns, use Connect with Meta on the Numbers page.",
      };
    case "invalid_token":
      return {
        // Not "invalid": the token was fine when it was copied, and saying
        // otherwise sends the operator looking for the wrong mistake.
        title: "Meta no longer accepts this token",
        detail:
          "It has expired or been revoked. The App Dashboard's test token lasts about a day — copy a fresh one and paste it here.",
      };
    case "no_waba":
      // The panel answers this one with a question (the WABA id field), so
      // this copy exists for the case where it somehow cannot.
      return {
        title: "No WhatsApp account named",
        detail:
          "Meta did not say which WhatsApp Business Account this token reaches. Nothing was attached. Enter the account's id and Meta will be asked whether this token can read it.",
      };
    case "no_access":
      // Graph answers a mistyped id and an unassigned asset with the same
      // refusal, so both remedies are named. Meta's sentence follows because
      // it is the one thing here the console did not write.
      return {
        title: "This token cannot read that account",
        // One template literal rather than a concatenation because biome's
        // `useTemplate` rule refuses the latter; the sentence is unchanged.
        detail: `Meta did not let this token read the WhatsApp Business Account you named. Check the id, and that the account is assigned to the token's system user with WhatsApp permissions.${detail ? ` Meta said: ${detail}` : ""}`,
      };
    case "no_phone":
      return {
        title: "No phone number on that account",
        detail:
          "Meta let this token read the WhatsApp Business Account you named, but there is no phone number on it. Add one in WhatsApp Manager, then attach again.",
      };
    case "multiple":
      // The panel renders the candidates itself, so this exists for the case
      // where it somehow has none to show.
      return {
        title: "More than one account",
        detail:
          "This token reaches several WhatsApp Business Accounts. Pick the one to connect — nothing was attached.",
      };
    case "owned":
      return {
        title: "Already connected elsewhere",
        detail:
          "This WhatsApp Business Account belongs to another Eccos workspace. It has to be disconnected there before it can be attached here.",
      };
    default:
      return {
        title: "Meta refused the connection",
        detail: detail ?? "Meta refused the connection without saying why.",
      };
  }
}
