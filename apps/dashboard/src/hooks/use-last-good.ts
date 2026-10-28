import { useRef } from "react";

import type { Failure, Result } from "../server/gateway";

/** The data a page shows, with the failure of the refresh that did not replace it, if any. */
export type Shown<T> = { ok: true; data: T; failure: Failure | null } | Failure;

export interface LastGood<T> {
  scope: string;
  data: T;
}

/**
 * The read a page shows, given the last successful one. A successful read
 * becomes the last good one. A failed read shows the last good data for the
 * same scope (another number, another thread starts from nothing), with the
 * failure beside it. Pure, so the rule is asserted without React.
 */
export function keepLastGood<T>(
  good: LastGood<T> | null,
  result: Result<T> | null,
  scope: string,
): { shown: Shown<T> | null; good: LastGood<T> | null } {
  if (!result) return { shown: null, good };
  if (result.ok) return { shown: { ok: true, data: result.data, failure: null }, good: { scope, data: result.data } };
  if (good?.scope === scope) return { shown: { ok: true, data: good.data, failure: result }, good };
  return { shown: result, good };
}

/** Keeps the last good read across renders, so a failed refresh shows what was loaded before. */
export function useLastGood<T>(result: Result<T>, scope: string): Shown<T>;
export function useLastGood<T>(result: Result<T> | null, scope: string): Shown<T> | null;
export function useLastGood<T>(result: Result<T> | null, scope: string): Shown<T> | null {
  const ref = useRef<LastGood<T> | null>(null);
  const next = keepLastGood(ref.current, result, scope);
  ref.current = next.good;
  return next.shown;
}
