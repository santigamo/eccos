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
  payload: string;
  received_at: number;
}

export interface OutboundRow {
  id: number;
  transport_message_id: string | null;
  recipient: string;
  request: string;
  status: string;
  error: string | null;
  created_at: number;
}

export interface DeliveryRecord {
  id: number;
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

export interface GatewayApi {
  getStatus(wabaId: string): Promise<GatewayStatus>;
  getConfig(wabaId: string): Promise<Record<string, string>>;
  listInbound(opts: ListOpts): Promise<InboundRow[]>;
  listOutbound(opts: ListOpts): Promise<OutboundRow[]>;
  listDeliveries(opts: DeliveryListOpts): Promise<DeliveryRecord[]>;
  getDelivery(id: number, wabaId: string): Promise<DeliveryRecord | null>;
  retryDelivery(id: number, wabaId: string): Promise<{ ok: boolean; previousStatus: string | null }>;
  listTemplates(wabaId: string, limit?: number): Promise<TemplatesResult>;
  getSubscriberConfig(wabaId: string): Promise<SubscriberConfig>;
  setSubscriberConfig(input: SetSubscriberConfigInput, wabaId: string): Promise<{ ok: true }>;
  resubscribe(wabaId: string): Promise<ResubscribeResult>;
  /** Right-to-erasure (GDPR Art. 17): delete/redact every stored trace of a phone
   * number across inbound_events, outbound_messages, and deliveries. */
  eraseByPhone(phone: string, wabaId: string): Promise<EraseByPhoneResult>;
}
