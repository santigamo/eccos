/** Coexistence sync webhooks Meta sends once per number; captured raw because
 * they cannot be requested again. Matched by `field`, never by value shape:
 * history media also arrives as `history`, carrying `messages[]`. */
export const SYNC_FIELDS = new Set(["history", "smb_app_state_sync"]);

/** WABA id → the sync fields its entries carry in this webhook. */
export function syncFieldsByWaba(payload: unknown): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const entries = (payload as { entry?: unknown })?.entry;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const { id, changes } = (entry ?? {}) as { id?: unknown; changes?: unknown };
    if (typeof id !== "string") continue;
    for (const change of Array.isArray(changes) ? changes : []) {
      const field = (change as { field?: unknown })?.field;
      if (typeof field !== "string" || !SYNC_FIELDS.has(field)) continue;
      const fields = out.get(id) ?? new Set<string>();
      fields.add(field);
      out.set(id, fields);
    }
  }
  return new Map([...out].map(([id, fields]) => [id, [...fields].sort()]));
}
