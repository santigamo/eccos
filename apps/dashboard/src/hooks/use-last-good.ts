import { useEffect, useRef } from "react";

import type { Failure, Result } from "../server/gateway";
import { clientGeneration, resetClientState } from "./client-state";

/** The data a page shows, with the failure of the refresh that did not replace it, if any. */
export type Shown<T> = { ok: true; data: T; failure: Failure | null } | Failure;

export interface LastGood<T> {
  scope: string;
  data: T;
}

/** The server said no: who is asking or what they may see changed, so earlier data is not theirs to show. */
export const isDenial = (failure: Failure): boolean => failure.kind !== "unreachable";

/**
 * The read a page shows, given the last successful one. A successful read
 * becomes the last good one. A transport failure shows the last good data for
 * the same scope (another number, another thread starts from nothing), with the
 * failure beside it; a denial (unauthenticated, forbidden) shows only itself
 * and forgets the data. Pure, so the rule is asserted without React.
 */
export function keepLastGood<T>(
  good: LastGood<T> | null,
  result: Result<T> | null,
  scope: string,
): { shown: Shown<T> | null; good: LastGood<T> | null } {
  if (!result) return { shown: null, good };
  if (result.ok) return { shown: { ok: true, data: result.data, failure: null }, good: { scope, data: result.data } };
  if (isDenial(result)) return { shown: result, good: null };
  if (good?.scope === scope) return { shown: { ok: true, data: good.data, failure: result }, good };
  return { shown: result, good };
}

/** Keeps the last good read across renders, so a failed refresh shows what was loaded before. */
export function useLastGood<T>(result: Result<T>, scope: string): Shown<T>;
export function useLastGood<T>(result: Result<T> | null, scope: string): Shown<T> | null;
export function useLastGood<T>(result: Result<T> | null, scope: string): Shown<T> | null {
  const ref = useRef<LastGood<T> | null>(null);
  // The generation is part of the scope: after a reset nothing matches.
  const next = keepLastGood(ref.current, result, `${clientGeneration()}:${scope}`);
  ref.current = next.good;
  useEffect(() => {
    if (result && !result.ok && isDenial(result)) resetClientState();
  }, [result]);
  return next.shown;
}
