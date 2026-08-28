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

export interface AccountWabaResource {
  accountId: string;
  wabaId: string;
  callbackUrl: string | null;
  createdAt: number;
  provisionedAt: number | null;
  status: ProvisioningStatus;
  provisioningError: string | null;
  phones: Omit<AccountPhoneResource, "wabaId">[];
}

/** Enumeration of an account's durable resources as seen by the operator.
 * Credentials are never exposed (no API-key hashes, no Meta tokens). */
export interface AccountResources {
  account: AccountSummary | null;
  keys: AccountKeyResource[];
  wabas: AccountWabaResource[];
  phones: AccountPhoneResource[];
}

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
  /** Right-to-erasure (GDPR Art. 17): delete/redact every stored trace of a phone
   * number across inbound_events, outbound_messages, and deliveries. */
  eraseByPhone(phone: string, wabaId: string, accountId: string): Promise<EraseByPhoneResult>;
  exportData(wabaId: string, accountId: string): Promise<GatewayExport>;
  /** Enumerate the durable resources owned by one account. */
  listAccountResources(accountId: string): Promise<AccountResources>;
}
