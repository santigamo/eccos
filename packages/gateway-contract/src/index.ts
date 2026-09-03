/**
 * Single source of truth for the Eccos gateway operator RPC surface.
 *
 * Both the gateway Worker (which `implements GatewayApi` on its `GatewayRPC`
 * entrypoint) and the dashboard Worker (which calls the `GATEWAY` service
 * binding) depend on this types-only package, so the contract can never drift
 * between the two. No runtime code, no dependencies.
 */

export type Health = "healthy" | "degraded" | "unhealthy";

export interface InboundRow {
  id: number;
  type: string;
  transport_message_id: string | null;
  message_id: string | null;
  phone_number_id: string | null;
  payload: string;
  received_at: number;
}

export interface OutboundRow {
  id: number;
  transport_message_id: string | null;
  recipient: string;
  phone_number_id: string | null;
  request: string;
  status: string;
  error: string | null;
  created_at: number;
}

export interface DeliveryRecord {
  id: number;
  phone_number_id: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number;
  created_at: number;
  /**
   * Epoch ms of the terminal transition (`delivered` or `failed`), or null when
   * the row has not finished — queued, held because no forwarding target is
   * configured, or waiting between retries. Rows written before the column
   * existed are also null. NEVER substitute `created_at` for it: that is the
   * moment the batch ARRIVED, and reporting it as the moment it landed is the
   * exact confusion this column was added to end.
   */
  finished_at: number | null;
  /** The forwarded `{ events: [...] }` JSON. An empty string means the payload was
   * REDACTED (content retention expiry or erasure): only metadata remains and the
   * row can no longer be replayed. */
  payload: string;
}

export interface OperatorCounts {
  inbound: number;
  outbound: Record<string, number>;
  deliveries: Record<string, number>;
}

export interface GatewayStatus {
  name: string;
  version: string;
  health: Health;
  connection: { wabaId: string | null; phoneNumberId: string | null; displayPhone: string | null; connectedAt: string | null };
  counts: OperatorCounts;
}

export type TemplatesResult = { ok: true; data: unknown } | { ok: false; error: unknown };

export type ListOpts = { wabaId: string; limit?: number; before?: number };

export type DeliveryListOpts = ListOpts & { status?: string };

/**
 * The newest forwarding attempt on a WABA — the answer to the only question the
 * Webhooks page really asks: "is my receiver getting events?".
 *
 * Deliberately the LAST delivery row and not an aggregate: aggregates say how
 * the queue has behaved over its whole retained history, and an operator who
 * just changed something wants to know what happened afterwards. The totals
 * remain available in {@link OperatorCounts}.
 */
export interface LastForward {
  /** The delivery row's own status: `pending`, `delivered` or `failed`. A row
   * held because no target is configured is `pending` with `attempts: 0` — it
   * has not been tried, not failed. */
  status: string;
  /** Forward attempts spent so far; `0` on a row nothing has been tried on. */
  attempts: number;
  /** Epoch ms the batch was enqueued: when the event ARRIVED, never when it landed. */
  createdAt: number;
  /**
   * Epoch ms of the terminal transition, or null when the row has not finished
   * (queued, held for want of a target, or between retries). Null is a fact, not
   * a gap to fill: a reader that falls back to {@link LastForward.createdAt}
   * turns "queued 15 days ago" into "delivered 15 days ago" and states something
   * it does not know.
   */
  finishedAt: number | null;
  /** Why the last attempt failed, verbatim from `deliveries.last_error`. Null on
   * success, and on a row no attempt has been made against. */
  lastError: string | null;
}

/** Outbound-forwarding target as seen by the operator. The secret is NEVER exposed. */
export interface SubscriberConfig {
  url: string | null;
  hasSecret: boolean;
  /**
   * The newest delivery row, or null when nothing has ever been enqueued. It
   * rides this read instead of owning an RPC method of its own: inside the
   * Durable Object it is one primary-key-ordered `LIMIT 1`, which costs far less
   * than a second round-trip over the service binding.
   */
  lastForward: LastForward | null;
}

/**
 * Write the forwarding target.
 *
 * Every field states one intention and only one, because the console renders one
 * control per intention and an operator cannot undo a state that meant something
 * else than they read into it.
 *
 * `url`
 *  - a string — store it (https, no credentials, no private host);
 *  - `null` — REMOVE the target. Nothing is forwarded afterwards; new events are
 *    held in the queue rather than failed against a destination that is gone.
 *
 * `secret` — the HMAC key behind `x-eccos-signature`
 *  - omitted — keep whatever is stored. That is what an untouched password field
 *    means, and it is now the only thing it can mean;
 *  - a non-empty string — replace it. An empty string is REFUSED, not silently
 *    read as "keep": clearing has its own spelling, so the ambiguity is gone;
 *  - `null` — REMOVE it. Deliveries then forward unsigned.
 *
 * The two are independent on purpose. Removing a target keeps the secret, so
 * re-pointing at a receiver does not quietly change what that receiver must
 * verify; a caller that wants removal to forget everything says both out loud
 * (`{ url: null, secret: null }`).
 *
 * The secret VALUE never comes back out — see {@link SubscriberConfig}, where
 * `hasSecret` is its only trace. That is a stated property of the operator API
 * (`docs/threat-model.md`), not an omission.
 */
export interface SetSubscriberConfigInput {
  url: string | null;
  secret?: string | null;
}

export type ResubscribeResult = { ok: true } | { ok: false; error: string };

/**
 * Outcome of an operator-triggered provisioning re-check (eccos-lpk).
 *
 * Two layers, because "the attempt ran" and "the WABA is connected" are
 * different facts: `ok` reports that the account owns the WABA and the
 * reconciler ran, `status` is where the WABA stands afterwards, and `error` is
 * the saga's own reason when it is not `active` yet. A `pending` status with a
 * null error is the normal answer while an attempt is still backing off.
 */
export type ReconcileWabaResult =
  | { ok: true; status: ProvisioningStatus; error: string | null }
  | { ok: false; error: string };

/** Per-table effect counts of an erasure request — returned so the operator can
 * evidence the deletion towards the data subject / client. */
export interface ErasureCounts {
  inboundEventsDeleted: number;
  outboundMessagesDeleted: number;
  /** Delivery rows whose payload was rewritten (matching events removed) or fully redacted. */
  deliveriesRedacted: number;
  /** Pending delivery rows deleted because no events remained to forward. */
  deliveriesDeleted: number;
}

/** `phone` echoes the normalized (digits-only) number the match ran against. */
export type EraseByPhoneResult =
  | { ok: true; phone: string; counts: ErasureCounts }
  | { ok: false; error: string };

// --- Account resources (account-scoped operator surface) --------------------

export interface AccountSummary {
  accountId: string;
  name: string;
  createdAt: number;
}

export interface AccountKeyResource {
  keyId: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface AccountPhoneResource {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
}

export type ProvisioningStatus = "pending" | "active" | "failed";

/** How a WABA was onboarded: `coexistence` is the WhatsApp Business app flow. */
export type WabaOnboardingType = "standard" | "coexistence";

/**
 * Where a WABA stands on the synchronisation Meta requires after a WhatsApp
 * Business app (coexistence) onboarding.
 *
 * - `not_applicable` — not a coexistence onboarding; nothing is owed.
 * - `pending` — owed, not yet initiated, window still open.
 * - `initiated` — contacts and message history have both been requested.
 * - `unconfirmed` — a request was issued and Meta never confirmed it. Terminal:
 *   each sync is allowed once, so it cannot be safely retried.
 * - `not_coexistence` — Eccos recorded a coexistence onboarding and Meta reports
 *   the number is not one, so nothing was issued. Terminal, and not a failure.
 * - `expired` — the 24-hour window closed with the history sync not initiated.
 *   Terminal: Meta's remedy is offboarding the customer.
 */
export type CoexistenceSyncStatus =
  | "not_applicable"
  | "pending"
  | "initiated"
  | "unconfirmed"
  | "not_coexistence"
  | "expired";

/**
 * Coexistence obligations of one WABA as the console sees them.
 *
 * `onboardingType` is what Eccos *asked* Meta for; `verifiedOnboardingType` is
 * what Meta reported the number actually is, read back from the phone number
 * itself, or null while it has not been established. The two disagreeing is the
 * case the console has to be able to show, because the syncs are then never
 * issued — deliberately, and once only ever.
 */
export interface CoexistenceResource {
  onboardingType: WabaOnboardingType;
  verifiedOnboardingType: WabaOnboardingType | null;
  status: CoexistenceSyncStatus;
  /** Epoch ms by which message history must have been initiated; null when nothing is owed. */
  deadlineAt: number | null;
  contactsStartedAt: number | null;
  contactsRequestId: string | null;
  historyStartedAt: number | null;
  historyRequestId: string | null;
  /** Why the sync step did not complete, in words meant for an operator. */
  error: string | null;
}

export interface AccountWabaResource {
  accountId: string;
  wabaId: string;
  callbackUrl: string | null;
  createdAt: number;
  provisionedAt: number | null;
  status: ProvisioningStatus;
  provisioningError: string | null;
  phones: Omit<AccountPhoneResource, "wabaId">[];
  /** Coexistence state (eccos-vss). Already travelled over the binding before it
   * was declared here; declaring it is what lets the console read it. */
  coexistence: CoexistenceResource;
}

/** Enumeration of an account's durable resources as seen by the operator.
 * Credentials are never exposed (no API-key hashes, no Meta tokens). */
export interface AccountResources {
  account: AccountSummary | null;
  keys: AccountKeyResource[];
  wabas: AccountWabaResource[];
  phones: AccountPhoneResource[];
}

export interface ConnectStartResult {
  url: string;
  state: string;
  expiresAt: number;
}

/**
 * Why Embedded Signup did not connect a number, as carried back to the console
 * in the return URL. Only this closed vocabulary travels in the query string —
 * a raw Graph error message never lands in browser history. The console owns
 * the operator-facing wording for each code.
 */
export type ConnectFailureCode =
  /** The OAuth state expired or did not match; nothing was exchanged. */
  | "state"
  /** Meta ended the flow without a code (operator cancelled, or app denied). */
  | "denied"
  /** Every candidate WABA already belongs to a different Eccos account. */
  | "owned"
  /** The Meta login exposed no WhatsApp Business Account at all. */
  | "no_waba"
  /** Anything else, including Graph failures during the exchange. */
  | "failed";

/**
 * Query parameters the gateway sets on the console return URL. Success is
 * silent: the console shows the connected numbers in its own table, so only a
 * failure or a partial result carries a parameter.
 */
export interface ConnectReturnParams {
  connectError?: ConnectFailureCode;
  /** WABAs the token could see that belong to another account and were skipped. */
  connectSkipped?: number;
}

/** One phone number a completed Embedded Signup handoff connected. */
export interface ConnectedPhoneResource {
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
}

/**
 * Outcome of exchanging an Embedded Signup authorization code and registering
 * everything it unlocked.
 *
 * Shared by both entry points: the gateway's own `POST /connect/exchange` and
 * the dashboard's JavaScript-SDK page, which posts the code to a server
 * function that forwards it over this binding — so the browser never holds an
 * account API key.
 */
export type ConnectExchangeResult =
  | {
      ok: true;
      waba_id: string;
      /** Empty when the flow completed without a business phone number (v4). */
      phone_number_id: string;
      display_phone_number: string;
      connected: ConnectedPhoneResource[];
      status: ProvisioningStatus;
      /** WABAs the token could see but that belong to another account. */
      warnings?: string[];
    }
  | { ok: false; error: string; code: ConnectFailureCode };

/**
 * One WhatsApp Business Account a pasted token can reach, offered to the
 * operator as a choice.
 *
 * Returned ONLY with {@link ManualConnectFailureCode} `multiple`, and nothing
 * is registered when it is: a system-user token can see every WABA a business
 * manages, and registering all of them on one paste would mass-attach an
 * agency's clients. Ambiguity is answered with a question, not a guess.
 */
export interface TokenWabaCandidate {
  wabaId: string;
  phones: Omit<AccountPhoneResource, "wabaId">[];
}

/**
 * Why a pasted Meta token did not connect a number, in the console's closed
 * vocabulary (same design as {@link ConnectFailureCode}; raw Graph errors never
 * drive UI).
 *
 * Deliberately a SEPARATE vocabulary rather than a widened
 * `ConnectFailureCode`: that one also travels in the Embedded Signup return
 * URL's query string, and a code that can never appear there does not belong
 * in it.
 */
export type ManualConnectFailureCode =
  /**
   * Meta says this token was issued by another app, so this deployment cannot
   * introspect it — and therefore cannot trust it. The remedy is Embedded
   * Signup, which is how a business connects a WABA it owns.
   */
  | "foreign_app"
  /** An own-app token that Meta reports expired or revoked. Paste a fresh one. */
  | "invalid_token"
  /**
   * Nothing was named and discovery found nothing: the token's `debug_token`
   * answer listed no WhatsApp Business Account (Meta returns
   * `granular_scopes[].target_ids` nullable, and a System User token routinely
   * comes back without it), or every listed one had no phone number. Nothing
   * was registered. This is a QUESTION, not a verdict: the console answers it
   * by asking for the WABA id, which then seeds discovery directly. Returned
   * only when no `wabaId` was supplied — a named WABA always resolves to
   * `no_access`, `no_phone`, `owned`, success, or `failed`.
   */
  | "no_waba"
  /**
   * Meta refused to let this token read the WABA the operator named
   * (`GET /<waba_id>/phone_numbers` answered 4xx). Covers a mistyped id and a
   * WABA not assigned to the token's system user alike: Graph answers both
   * with the same "does not exist or cannot be loaded" refusal, so the console
   * names both remedies. `detail` carries Meta's sentence. Nothing registered.
   */
  | "no_access"
  /**
   * Meta let this token read the named WABA and it has no phone number.
   * Nothing to register — the same rule discovery applies to an unnamed one —
   * but distinguished from `no_waba` so the console does not ask for the id
   * it was just given.
   */
  | "no_phone"
  /** The token reaches several WABAs and none was chosen; nothing was registered. */
  | "multiple"
  /** The chosen WABA already belongs to a different Eccos account. */
  | "owned"
  /** Anything else, including Graph failures during discovery or registration. */
  | "failed";

/**
 * Outcome of connecting a WABA from a token the operator pasted (eccos-up9).
 *
 * The success branch mirrors {@link ConnectExchangeResult}'s: the same
 * registration path produced it, so the console renders both the same way. The
 * failure branch carries the closed code plus, for `multiple`, the choice that
 * resolves it.
 *
 * The pasted token is NEVER part of this shape — not echoed, not fingerprinted,
 * not summarised. It goes in and only identifiers come back.
 */
export type ManualConnectResult =
  | {
      ok: true;
      waba_id: string;
      phone_number_id: string;
      display_phone_number: string;
      connected: ConnectedPhoneResource[];
      status: ProvisioningStatus;
      /** WABAs the token could see but that belong to another account. */
      warnings?: string[];
    }
  | {
      ok: false;
      code: ManualConnectFailureCode;
      /** Meta's own sentence where it explains (for `no_access`, the refusal it
       * answered the read with); never a discriminator. */
      detail: string | null;
      /** The WABAs to choose between. Present only for `multiple`. */
      candidates?: TokenWabaCandidate[];
    };

/**
 * One console-originated template send (the "Send test" sheet).
 *
 * Deliberately NOT a generic "send any Meta body over the binding": the gateway
 * builds the Meta message itself from these validated fields, so a compromised
 * console session can only ever produce a template send, never a freeform spam
 * pipe. Widening this shape is a security decision, not a convenience one.
 */
export interface SendTemplateTestInput {
  wabaId: string;
  phoneNumberId: string;
  /** Digits only; the console normalizes before it ever reaches the binding. */
  to: string;
  templateName: string;
  languageCode: string;
  /** Positional {{1}}..{{n}} body values, in order. */
  bodyParams?: string[];
}

/**
 * Closed failure vocabulary for a test send — the console owns the wording per
 * code (same design as {@link ConnectFailureCode}; raw Graph errors never drive
 * UI). An unmapped Graph code degrades to `graph`, which is legible rather than
 * wrong.
 */
export type SendTestFailureCode =
  /** Eccos' own limiter refused; Meta was never called. */
  | "rate_limited"
  /** The requested phone is not registered on the WABA. */
  | "no_phone"
  /** Graph 131030 — the Cloud API test number's recipient allowlist. */
  | "recipient_not_allowlisted"
  /** Graph 132001 — no approved translation for this name + language. */
  | "template_not_found"
  /** Graph 132000 — the template expects different parameters. */
  | "parameter_mismatch"
  /** Anything else; `detail` carries Meta's own message text. */
  | "graph";

export type SendTemplateTestResult =
  | { ok: true; messageId: string }
  | { ok: false; code: SendTestFailureCode; detail: string | null };

/**
 * One console-authored message template (the "New template" sheet).
 *
 * Narrow for the same reason as {@link SendTemplateTestInput}: the gateway
 * builds the Graph `components[]` itself from these validated fields, so a
 * compromised console session can only ever author a **body-only text
 * template** — never a media header, a button, or an authentication template.
 * Widening this shape is a security decision, not a convenience one.
 *
 * The scope is also the intersection with what the console can SEND: every
 * draft this accepts must come back from Meta as a row `analyzeTemplate`
 * classifies `ready`, or the console would author templates its own "Send test"
 * sheet refuses.
 */
export interface CreateTemplateInput {
  wabaId: string;
  /** Meta's charset: `^[a-z0-9_]{1,512}$`. Names are unique per name+language. */
  name: string;
  /** `en` / `es` / `en_US` / `pt_BR`. */
  language: string;
  /** AUTHENTICATION is deliberately absent: it is preset content plus OTP
   * buttons, a different creation shape entirely. */
  category: "MARKETING" | "UTILITY";
  /** 1..1024 characters, positional `{{1}}..{{n}}` placeholders only. */
  bodyText: string;
  /** One example value per `{{n}}`, in order. Meta requires an example for
   * every parameter, and they are what its reviewers read. */
  bodyExamples?: string[];
}

/**
 * Closed failure vocabulary for a refused template creation — the console owns
 * the wording per code (same design as {@link SendTestFailureCode}; raw Graph
 * errors never drive UI).
 */
export type CreateTemplateFailureCode =
  /** Graph 100 / subcode 2388024 — this name already exists for this language.
   * The 30-day post-deletion name lock also lands here. */
  | "name_taken"
  /** Graph 100 without a matching subcode — Meta refused the shape. */
  | "invalid"
  /** Graph 80008 — Meta is rate-limiting template creation for this account. */
  | "rate_limited"
  /** Anything else; `detail` carries Meta's own message text. */
  | "graph";

/**
 * `status` and `category` are plain strings, not enums: they are Meta's answer,
 * not the console's request. Creation returns `PENDING`, and the returned
 * category may DIFFER from the one asked for — Meta recategorises on its own
 * (`allow_category_change` is now the default behaviour), and the console says
 * so rather than pretending it got what it asked for.
 */
export type CreateTemplateResult =
  | { ok: true; id: string; status: string; category: string }
  | { ok: false; code: CreateTemplateFailureCode; detail: string | null };

/**
 * Delete ONE translation of a template.
 *
 * `templateId` (Meta's `hsm_id`) is required, never a bare name: the name-only
 * form of Meta's DELETE removes **every language** of that template, and the
 * row the operator clicked is one name+language pair. The button must do what
 * the row shows.
 */
export interface DeleteTemplateInput {
  wabaId: string;
  name: string;
  /** Graph template id (`hsm_id`), digits only. */
  templateId: string;
}

export type DeleteTemplateResult =
  | { ok: true }
  | { ok: false; code: "graph"; detail: string | null };

export interface GatewayExport {
  inbound: InboundRow[];
  outbound: OutboundRow[];
  deliveries: DeliveryRecord[];
  config: Record<string, string>;
}

export interface GatewayApi {
  /** Every method requires the owning account's id: the gateway is unconditionally
   * account-scoped and fails closed when the WABA is not owned by the account. */
  getStatus(wabaId: string, accountId: string): Promise<GatewayStatus>;
  getConfig(wabaId: string, accountId: string): Promise<Record<string, string>>;
  listInbound(opts: ListOpts, accountId: string): Promise<InboundRow[]>;
  listOutbound(opts: ListOpts, accountId: string): Promise<OutboundRow[]>;
  listDeliveries(opts: DeliveryListOpts, accountId: string): Promise<DeliveryRecord[]>;
  getDelivery(id: number, wabaId: string, accountId: string): Promise<DeliveryRecord | null>;
  retryDelivery(
    id: number,
    wabaId: string,
    accountId: string,
  ): Promise<{ ok: boolean; previousStatus: string | null }>;
  listTemplates(wabaId: string, limit: number | undefined, accountId: string): Promise<TemplatesResult>;
  getSubscriberConfig(wabaId: string, accountId: string): Promise<SubscriberConfig>;
  setSubscriberConfig(
    input: SetSubscriberConfigInput,
    wabaId: string,
    accountId: string,
  ): Promise<{ ok: true }>;
  resubscribe(wabaId: string, accountId: string): Promise<ResubscribeResult>;
  /**
   * Send one template message from the console ("Send test").
   *
   * Narrow on purpose (see {@link SendTemplateTestInput}): the caller names a
   * template, a language and positional body values, and the gateway builds the
   * Meta body. Fail-closed on a non-active WABA, exactly like the HTTP send
   * path, and rate-limited through the SAME limiter and the SAME
   * `accountId:wabaId` key as `POST /v1/wabas/:wabaId/messages` — a console
   * session must never hold a bigger send budget than a stolen API key.
   */
  sendTemplateTest(input: SendTemplateTestInput, accountId: string): Promise<SendTemplateTestResult>;
  /**
   * Create one message template on the WABA ("New template").
   *
   * Narrow on purpose (see {@link CreateTemplateInput}): the caller names a
   * template and a body, and the gateway builds the Graph `components[]`.
   * WABA-level like `listTemplates` / `setSubscriberConfig` — it needs only the
   * WABA id and its stored token — so it works on a connected WABA that is
   * still waiting for its phone number: authoring precedes provisioning.
   * Ownership is enforced either way.
   */
  createTemplate(input: CreateTemplateInput, accountId: string): Promise<CreateTemplateResult>;
  /** Delete one translation of a template (by `hsm_id`, never by bare name).
   * WABA-level, same reachability as {@link GatewayApi.createTemplate}. */
  deleteTemplate(input: DeleteTemplateInput, accountId: string): Promise<DeleteTemplateResult>;
  /** Re-run the provisioning saga for one WABA the account owns, whatever its
   * status (a `pending` WABA is precisely the one worth re-checking, so this is
   * the one operator method that does not require an already-active WABA).
   * Idempotent and lease-guarded: it never provisions alongside the cron. */
  reconcileWaba(wabaId: string, accountId: string): Promise<ReconcileWabaResult>;
  /** Right-to-erasure (GDPR Art. 17): delete/redact every stored trace of a phone
   * number across inbound_events, outbound_messages, and deliveries. */
  eraseByPhone(phone: string, wabaId: string, accountId: string): Promise<EraseByPhoneResult>;
  exportData(wabaId: string, accountId: string): Promise<GatewayExport>;
  /** Enumerate the durable resources owned by one account. */
  listAccountResources(accountId: string): Promise<AccountResources>;
  /** Start Embedded Signup for one already-resolved account id (the dashboard
   * resolves it from the organization link; never a browser-supplied id).
   *
   * `returnTo` is the console URL the gateway hands the operator back to once
   * Meta's callback is handled. It is only accepted here, never on the public
   * `POST /connect/start`: this entrypoint is reachable solely over the service
   * binding, so the value comes from the console's own canonical origin rather
   * than from a browser. */
  startConnectForAccountId(accountId: string, returnTo?: string): Promise<ConnectStartResult>;
  /**
   * Exchange an Embedded Signup authorization code for a resolved account and
   * register everything it unlocks.
   *
   * This is the JavaScript-SDK half of Embedded Signup: `FB.login()` hands the
   * code to the page, the page posts it to the dashboard, and the dashboard
   * forwards it here. The code's TTL is **30 seconds**, so callers must not
   * buffer it. `state` is the one minted by `startConnectForAccountId` and is
   * consumed here; it must belong to the same account.
   *
   * There is no `redirect_uri`: a code from `FB.login()` was never bound to
   * one, and sending one would fail the exchange.
   */
  exchangeConnectCodeForAccountId(
    accountId: string,
    code: string,
    state: string,
    wabaId?: string,
  ): Promise<ConnectExchangeResult>;
  /**
   * Connect a WABA from a Meta access token an operator pasted into the console
   * (eccos-up9).
   *
   * This exists because Embedded Signup onboards BUSINESSES and therefore never
   * surfaces Meta's own Cloud API test WABA — the number App Review filming
   * runs on. Pasting its token is the only way to attach it.
   *
   * The token is classified before anything is written: `debug_token` can only
   * introspect tokens issued by this deployment's own Meta app, so a customer's
   * own-app token comes back `foreign_app` and is pointed at Embedded Signup
   * rather than half-registered. When the token reaches several WABAs and
   * `wabaId` names none of them, NOTHING is registered and the candidates come
   * back for the operator to choose from.
   *
   * `wabaId` is a SEED, not a filter. When it is named, discovery over
   * `debug_token`'s `target_ids` is skipped and the token is proven against
   * that WABA directly — `GET /<waba_id>/phone_numbers` is Meta's live answer
   * to "may this token read this account", which is stronger than the
   * issuance-time `target_ids` that Meta may simply omit (measured on a
   * System User token with the WABA assigned as an asset). Meta refusing the
   * read fails closed as `no_access`; a WABA another account already holds
   * still fails closed as `owned`. When nothing is named and discovery finds
   * nothing, `no_waba` is the question the console answers by asking for the
   * id.
   */
  connectWabaWithToken(
    accountId: string,
    token: string,
    wabaId?: string,
  ): Promise<ManualConnectResult>;
  /** Idempotent one-to-one organization→account provisioning saga (contract
   * §2). Creates the Eccos account and the active link atomically; no API key. */
  ensureOrganizationAccount(
    organizationId: string,
    name?: string,
  ): Promise<{ accountId: string; status: "active" | "existing" }>;
  /** Read the one-to-one organization→account link (contract §2). Unknown
   * organization → null; `pending`/`disabled` links fail closed upstream. */
  getOrganizationAccountLink(
    organizationId: string,
  ): Promise<{ accountId: string; status: "active" | "pending" | "disabled" } | null>;
}
