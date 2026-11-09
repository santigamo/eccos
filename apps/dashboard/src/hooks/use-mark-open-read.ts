import { useEffect, useRef } from "react";

import type { ConversationSummary } from "../server/gateway";

/**
 * Marks the open conversation read while it is on screen. One request at a time;
 * a failure is retried when the list next changes. `mark` must clear the row in
 * `items` on success: a row on an older page is not refreshed by a reload, and
 * would otherwise be marked again on every change of the list.
 */
export function useMarkOpenRead(
  items: ConversationSummary[],
  selectedWaId: string | undefined,
  mark: (row: ConversationSummary) => Promise<void>,
): void {
  const marking = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `items` is the trigger; `mark` is read as it stands
  useEffect(() => {
    const row = items.find((item) => item.waId === selectedWaId);
    if (!row || !(row.unreadCount > 0 || row.markedUnread)) return;
    if (document.visibilityState !== "visible" || marking.current) return;
    marking.current = true;
    mark(row)
      .catch(() => {})
      .finally(() => {
        marking.current = false;
      });
  }, [items, selectedWaId]);
}
