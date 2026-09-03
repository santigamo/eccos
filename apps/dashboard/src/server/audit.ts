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
  /** An Embedded Signup code exchanged through the JavaScript-SDK page. */
  | "connect_exchange"
  /**
   * One Embedded Signup session-logging event (Meta's `message` listener).
   * Carries the screen a customer abandoned on and the error code + session id
   * they reported — the only record of either, and the reference Meta support
   * asks for. Never carries the authorization code or any token.
   */
  | "connect_session_event"
  /**
   * One template message sent from the console's "Send test" sheet.
   *
   * NEVER carries the recipient or any parameter value. Parameters are message
   * content; the recipient is deliberately omitted, not even as a suffix,
   * because the full number already lives in the data-plane `outbound_messages`
   * row — which retention and `eraseByPhone` govern — while audit logs are not
   * per-phone erasable. A phone number here would silently break GDPR erasure
   * completeness. The record carries wabaId, phoneNumberId, template name,
   * language, the returned messageId, and the failure code as `detail`.
   */
  | "template_test_send"
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
