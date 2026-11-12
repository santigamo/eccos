/**
 * One-time backup codes waiting to be confirmed. Held here, outside any
 * component, and shown by one sheet at the app's root: the dialog or sheet
 * that enrolled can unmount without taking codes that cannot be shown again.
 */

interface Held {
  codes: string[];
  confirm: () => void;
}

const queue: Held[] = [];
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Put the codes on screen; resolves once the operator says they are saved. */
export function showBackupCodes(codes: string[]): Promise<void> {
  return new Promise((resolve) => {
    const held: Held = {
      codes,
      confirm: () => {
        const at = queue.indexOf(held);
        // Confirmed twice (a double click): there is nothing left to remove.
        if (at === -1) return;
        queue.splice(at, 1);
        changed();
        resolve();
      },
    };
    queue.push(held);
    changed();
  });
}

export function subscribeBackupCodes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function heldBackupCodes(): Held | null {
  return queue[0] ?? null;
}
