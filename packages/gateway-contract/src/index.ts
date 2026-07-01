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

export type ListOpts = { limit?: number; before?: number };

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

export interface GatewayApi {
  getStatus(): Promise<GatewayStatus>;
  getConfig(): Promise<Record<string, string>>;
  listInbound(opts?: ListOpts): Promise<InboundRow[]>;
  listOutbound(opts?: ListOpts): Promise<OutboundRow[]>;
  listDeliveries(opts?: DeliveryListOpts): Promise<DeliveryRecord[]>;
  getDelivery(id: number): Promise<DeliveryRecord | null>;
  retryDelivery(id: number): Promise<{ ok: boolean; previousStatus: string | null }>;
  listTemplates(limit?: number): Promise<TemplatesResult>;
  getSubscriberConfig(): Promise<SubscriberConfig>;
  setSubscriberConfig(input: SetSubscriberConfigInput): Promise<{ ok: true }>;
  resubscribe(): Promise<ResubscribeResult>;
}
