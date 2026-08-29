/**
 * Lightweight structured audit logging for sensitive dashboard mutations
 * (eccos-0x0.6, contract §4/§11 of the tenancy contract).
 *
 * Every sensitive action records who acted (userId, email), on which tenant
 * (organizationId, accountId), on what resource (wabaId, delivery id…), and
 * the outcome — WITHOUT logging tokens, message bodies, full phone numbers,
 * subscriber secrets, or API keys. Emitted to the Worker structured log where
 * the platform's observability pipeline (already enabled in wrangler.jsonc)
 * persists them.
 */

export type SensitiveAction =
  | "subscriber_config_write"
  | "resubscribe"
  | "connect_start"
  | "api_key_issue"
  | "api_key_revoke"
  | "export_data"
  | "erase_by_phone"
  | "member_invited"
  | "member_role_changed"
  | "member_removed";

export interface AuditEvent {
  action: SensitiveAction;
  /** Who acted. Email domain only is acceptable when the address itself is
   * considered PII by the deployment — the id is the stable actor key. */
  actorUserId: string;
  organizationId: string;
  accountId: string | null;
  /** Resource selectors (wabaId, deliveryId…). Values must be non-sensitive
   * identifiers only. */
  resource?: Record<string, string | number | null>;
  outcome: "success" | "denied" | "failed";
  detail?: string;
}

export function auditEvent(event: AuditEvent): void {
  console.info(
    JSON.stringify({
      level: "info",
      area: "audit",
      ...event,
      // Defense in depth: strip anything undefined for stable log shape.
      resource: event.resource ?? null,
      detail: event.detail ?? null,
    }),
  );
}
