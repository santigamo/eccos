/**
 * One audit line per mutating tool call, in the console's shape (apps/dashboard/src/server/audit.ts)
 * plus `via: "mcp"` and the client that acted. The actor is the user, so an incident review reads
 * the same whether a person or their agent acted. Identifiers, the tool name and the outcome only:
 * never tool inputs, results or tokens.
 */

/** Non-sensitive identifiers of what the call touched (wabaId, keyId…). */
export type AuditResource = Record<string, string | number | null>;

export interface McpAuditEvent {
  /** The tool's name. */
  action: string;
  actorUserId: string;
  organizationId: string;
  accountId: string;
  clientId: string;
  resource: AuditResource | null;
  outcome: "success" | "denied" | "failed";
  detail: string | null;
}

export function auditEvent(event: McpAuditEvent): void {
  console.info(JSON.stringify({ level: "info", area: "audit", via: "mcp", ...event }));
}
