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

/** Outbound-forwarding target as seen by the operator. The secret is NEVER exposed. */
export interface SubscriberConfig {
  url: string | null;
  hasSecret: boolean;
}

/** Rotate the forwarding target. `url` is always set; `secret` is only set when provided. */
export interface SetSubscriberConfigInput {
  url: string;
  secret?: string;
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
