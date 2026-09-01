/**
 * reccado-backed `MailSender` — the production email provider adapter
 * (eccos-3ne), replacing the previous Resend adapter outright. There is no
 * dual-provider or shadow path: while there are no customers, a second live
 * send path is a second thing to be wrong.
 *
 * The frozen contract:
 *
 *   POST <RECCADO_ENDPOINT>                 # …/v1/mailboxes/{id}/transactional/messages
 *   Authorization: Bearer <key>
 *   Idempotency-Key: <caller-chosen, MANDATORY — 400 without it>
 *   Content-Type: application/json          # 415 otherwise; 100 KB body cap
 *   {"template":"…","to":"…","variables":{…}}
 *
 *   200 {"status":"sent"|"duplicate", "requestId", "providerMessageId"}
 *   202 {"status":"accepted"}
 *   502 {"status":"permanent_failure"}      — definitively did not arrive
 *   504 {"status":"unknown"}                — TERMINAL (see SendOutcome)
 *   409 {"status":"idempotency_conflict"}   — same key, different payload
 *   429 quota_exceeded
 *   401 missing_authorization · 400 idempotency_key_required · 403 everything else
 *
 * Security/privacy invariants (contract §8):
 * - the API key lives only in a Worker secret (`RECCADO_API_KEY`), never in the
 *   repo, the client, or logs;
 * - the Idempotency-Key is a SHA-256 digest, never a raw token: the provider
 *   stores `client_idempotency_key` deliberately and never purges it;
 * - action-capable URLs travel in the request body and are never logged.
 *
 * There is NO retry and NO replay loop, by design. `504 unknown` is terminal:
 * replaying the same key returns the stored status without re-asking the
 * provider, and delivery events cannot resolve it because they correlate by a
 * provider message id that is null exactly when the outcome is unknown.
 */

import {
  MailProviderError,
  TEMPLATE_VARIABLES,
  type MailSender,
  type MailTemplateMessage,
  type SendOutcome,
} from "./mail";

/** Env bindings/secrets the adapter reads. Both are Worker secrets. */
export interface ReccadoMailEnv {
  /** Worker secret. */
  RECCADO_API_KEY?: string;
  /**
   * Full message endpoint, e.g.
   * `https://<host>/v1/mailboxes/<mailboxId>/transactional/messages`.
   * A Worker secret rather than a var: it carries the provider host, and
   * `apps/dashboard/wrangler.jsonc` lives in a public repo.
   */
  RECCADO_ENDPOINT?: string;
}

/**
 * The provider enforces a 100 KB body cap. We check it before sending so an
 * oversized payload reads as the bug it is rather than as a transport error.
 */
const MAX_BODY_BYTES = 100 * 1024;

/** Provider `status` values that a 403 can carry. */
const SUPPRESSED = "recipient_suppressed";
const QUOTA_EXCEEDED = "quota_exceeded";

interface ProviderBody {
  status?: string;
  requestId?: string;
  providerMessageId?: string | null;
}

export class ReccadoMailSender implements MailSender {
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(env: ReccadoMailEnv) {
    const apiKey = env.RECCADO_API_KEY?.trim();
    if (!apiKey) {
      // Fail closed: a configured-but-unkeyed deployment must not boot.
      throw new Error("RECCADO_API_KEY must be configured for the mail adapter");
    }
    // The endpoint is CONFIGURATION, not a constant: the provider's custom
    // domain sits behind Cloudflare Access and answers only on its workers.dev
    // host today. The contract is identical on both, so which host we talk to
    // is a deployment decision — hardcoding either one would strand this
    // deployment the moment the other becomes the live one.
    const endpoint = env.RECCADO_ENDPOINT?.trim();
    if (!endpoint) {
      throw new Error("RECCADO_ENDPOINT must be configured for the mail adapter");
    }
    this.apiKey = apiKey;
    // Validated at construction, not at the first send: a malformed endpoint is
    // a broken deployment, and it should refuse to boot rather than wait for a
    // user-visible email to fail.
    this.endpoint = validateEndpoint(endpoint);
  }

  async sendTemplate(msg: MailTemplateMessage): Promise<SendOutcome> {
    assertVariablesMatchTemplate(msg);

    const body = JSON.stringify({
      template: msg.template,
      to: msg.to,
      variables: msg.variables,
    });
    const size = new TextEncoder().encode(body).byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new MailProviderError(
        "contract_violation",
        `mail body is ${size} bytes, over the provider's ${MAX_BODY_BYTES}-byte cap`,
      );
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        // MANDATORY: the provider answers 400 without it.
        "idempotency-key": msg.idempotencyKey,
        // Anything else is a 415.
        "content-type": "application/json",
      },
      body,
    });

    return mapResponse(response.status, await readBody(response));
  }
}

/**
 * Validate the one configured endpoint, and fail closed on anything malformed.
 *
 * WHY THIS IS ONE SETTING AND NOT TWO (a host plus a mailbox id): one API key
 * addresses exactly one mailbox. The binding is fixed when the key is minted,
 * from the owning Durable Object's name, and there is no way to mint a
 * multi-mailbox key — so a separate mailbox id could only ever agree with the
 * key or contradict it. It cannot add information; it can only add a mistake.
 *
 * And that mistake is reported misleadingly. Keys are stored inside the owning
 * mailbox's own Durable Object, so a key minted for mailbox A presented against
 * mailbox B's path is looked up in B's storage, is simply absent, and comes back
 * `403 invalid_api_key` — not a binding-mismatch error. The operator is told
 * their key is wrong when what is actually wrong is their pairing. Carrying one
 * value makes that failure unreachable, which is the whole point: do NOT
 * "improve" this back into a base URL plus a mailbox id.
 *
 * NOTE: there is no status-lookup setting either, and there must never be one —
 * the provider's status endpoint is this exact string plus `/<requestId>`. The
 * adapter has no status lookup today (a `504 unknown` is terminal by design; see
 * the file header), so if one is ever added it derives its URL that way.
 */
function validateEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("RECCADO_ENDPOINT must be an absolute URL");
  }
  // The same local-development carve-out the gateway applies in
  // `validatePublicOrigin` (apps/gateway/src/routes/connect.ts): https
  // everywhere, http only on the loopback hosts. One convention, not two.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname.toLowerCase(),
  );
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error("RECCADO_ENDPOINT must use https (http only on localhost)");
  }
  if (parsed.username || parsed.password) {
    // Credentials in the URL would ride along in logs and error messages; the
    // API key belongs in the Authorization header and nowhere else.
    throw new Error("RECCADO_ENDPOINT must not carry credentials in the URL");
  }
  if (parsed.search || parsed.hash) {
    // A status URL is this string plus `/<requestId>`; a query or fragment here
    // would not survive that concatenation.
    throw new Error("RECCADO_ENDPOINT must not carry a query string or fragment");
  }
  // A trailing slash would double up under that same concatenation.
  return parsed.href.replace(/\/$/, "");
}

/**
 * Variable validation is EXACT IN BOTH DIRECTIONS: a missing declared
 * placeholder and an extra undeclared variable are both hard rejects
 * provider-side. Catching the mismatch here turns what would be an opaque 403
 * into the local bug it actually is, and names the offending keys.
 */
function assertVariablesMatchTemplate(msg: MailTemplateMessage): void {
  const declared = TEMPLATE_VARIABLES[msg.template];
  if (!declared) {
    throw new MailProviderError(
      "contract_violation",
      `unknown mail template "${msg.template}"`,
    );
  }
  const supplied = Object.keys(msg.variables);
  const missing = declared.filter((name) => !(name in msg.variables));
  const extra = supplied.filter((name) => !declared.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    const missingPart = missing.length > 0 ? ` (missing: ${missing.join(", ")})` : "";
    const extraPart = extra.length > 0 ? ` (undeclared: ${extra.join(", ")})` : "";
    throw new MailProviderError(
      "contract_violation",
      `template "${msg.template}" variables do not match the declared set${missingPart}${extraPart}`,
    );
  }
}

/** Read the JSON envelope defensively — a malformed body must not mask the status. */
async function readBody(response: Response): Promise<ProviderBody> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ProviderBody) : {};
  } catch {
    return {};
  }
}

/**
 * Map one provider answer onto an outcome or a throw.
 *
 * Exported so tests can pin every documented status without standing up a
 * fetch mock for each one.
 */
export function mapResponse(status: number, body: ProviderBody): SendOutcome {
  switch (status) {
    // The provider owns the message. `duplicate` is a replay of a stored key:
    // still a success, and the caller may want to know it did not re-send.
    case 200:
      return body.status === "duplicate"
        ? { status: "sent", deduplicated: true }
        : { status: "sent" };
    case 202:
      return { status: "sent" };
    // Definitively did not arrive. Not an error — a delivery outcome the call
    // sites apply their own policy to.
    case 502:
      return { status: "undeliverable", reason: "permanent_failure" };
    // TERMINAL. Nothing to retry, nothing to poll; the caller logs and moves on.
    case 504:
      return { status: "unresolved" };
    case 400:
      throw new MailProviderError(
        "idempotency_key_required",
        "reccado rejected the send: the Idempotency-Key header is required",
        { httpStatus: status, providerStatus: body.status },
      );
    case 401:
      throw new MailProviderError(
        "missing_authorization",
        "reccado rejected the send: missing authorization",
        { httpStatus: status, providerStatus: body.status },
      );
    case 403:
      // The one 403 that is a delivery outcome rather than a broken
      // deployment: the address is suppressed at the provider.
      if (body.status === SUPPRESSED) {
        return { status: "undeliverable", reason: "recipient_suppressed" };
      }
      // A quota refusal can also arrive as a 403; it is an emergency either way.
      if (body.status === QUOTA_EXCEEDED) {
        throw new MailProviderError("quota_exceeded", "reccado sending quota exceeded", {
          httpStatus: status,
          providerStatus: body.status,
        });
      }
      throw new MailProviderError(
        "misconfiguration",
        `reccado rejected the send: ${body.status ?? "forbidden"}`,
        { httpStatus: status, providerStatus: body.status },
      );
    case 409:
      // Impossible by construction under deriveIdempotencyKey — the key derives
      // from the payload's unique element, so key and payload move together.
      // Reaching this means the derivation broke.
      throw new MailProviderError(
        "idempotency_conflict",
        "reccado reported an idempotency conflict: the key derivation is broken",
        { httpStatus: status, providerStatus: body.status },
      );
    case 415:
      throw new MailProviderError(
        "unsupported_media_type",
        "reccado rejected the send: the body must be application/json",
        { httpStatus: status, providerStatus: body.status },
      );
    case 429:
      throw new MailProviderError("quota_exceeded", "reccado sending quota exceeded", {
        httpStatus: status,
        providerStatus: body.status,
      });
    default:
      throw new MailProviderError(
        "unexpected_status",
        `reccado answered an undefined status ${status}`,
        { httpStatus: status, providerStatus: body.status },
      );
  }
}
