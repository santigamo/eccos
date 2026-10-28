/**
 * The generation of everything the browser keeps about the signed-in
 * workspace: last-good reads and the prefetch caches. A new generation means a
 * different principal or scope, so nothing from the old one may be shown.
 */
let generation = 0;
const listeners = new Set<() => void>();

export const clientGeneration = (): number => generation;

/** Drops client-held data: sign-out, organization switch, an authoritative denial. */
export function resetClientState(): void {
  generation++;
  for (const listener of listeners) listener();
}

export function onClientReset(listener: () => void): void {
  listeners.add(listener);
}
