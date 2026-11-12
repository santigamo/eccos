/**
 * The operator's side of step-up: a sensitive call refused for it is resolved
 * in place and run once more. Nothing navigates and no session changes, so the
 * page and whatever was typed into it stay as they were.
 */

import { isStepUpReason, type StepUpReason } from "@eccos/auth-baseline/step-up";

type Open = (reason: StepUpReason | null) => void;

let open: Open | null = null;
let settle: ((ok: boolean) => void) | null = null;

/** Answer the prompt that is waiting, if one is. */
export function settleStepUp(ok: boolean): void {
  const waiting = settle;
  settle = null;
  open?.(null);
  waiting?.(ok);
}

/**
 * The mounted sheet (`step-up-sheet.tsx`) registers how to show itself and
 * gets back its unregister, which declines whatever is still waiting.
 */
export function registerStepUpPrompt(show: Open): () => void {
  open = show;
  return () => {
    if (open !== show) return;
    settleStepUp(false);
    open = null;
  };
}

/** Ask the operator to enroll or confirm. A newer request declines an older one. */
export function promptStepUp(reason: StepUpReason): Promise<boolean> {
  if (settle) settleStepUp(false);
  if (!open) return Promise.resolve(false);
  open(reason);
  return new Promise<boolean>((resolve) => {
    settle = resolve;
  });
}

/** The step-up a result was refused for, if that is why it failed. */
export function stepUpReason(result: { ok: boolean; reason?: string }): StepUpReason | null {
  return !result.ok && isStepUpReason(result.reason) ? result.reason : null;
}

/**
 * Run a sensitive call; if it is refused for step-up, ask the operator to
 * enroll or confirm, then run it again. A declined prompt (or none mounted)
 * returns the refusal for the caller to show.
 */
export async function withStepUp<R extends { ok: boolean; reason?: string }>(
  call: () => Promise<R>,
): Promise<R> {
  const first = await call();
  const reason = stepUpReason(first);
  if (!reason || !(await promptStepUp(reason))) return first;
  return call();
}
