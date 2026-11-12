/**
 * The operator's side of step-up: a sensitive call refused for it is resolved
 * in place and run once more. Nothing navigates and no session changes, so the
 * page and whatever was typed into it stay as they were.
 */

import { isStepUpReason, type StepUpReason } from "@eccos/auth-baseline/step-up";

/**
 * The words for each step-up, in one place: the refusal a caller shows when
 * nobody could be asked, the sheet that asks, and the notice on the connect
 * fork. `title` is also what the button that opens the sheet says.
 */
export const STEP_UP_COPY: Record<
  StepUpReason,
  { title: string; refused: string; prompt: string; connect: string }
> = {
  "totp-required": {
    title: "Set up two-factor authentication",
    refused:
      "This action is protected. Set up two-factor authentication under Settings, then try again.",
    prompt:
      "The action you started needs it. Set it up here and the action continues; the page behind stays as you left it.",
    connect: "Connecting a number needs two-factor authentication on your account.",
  },
  "reauth-required": {
    title: "Confirm it's you",
    refused: "This action needs your two-factor code again. Try it once more and confirm when asked.",
    prompt:
      "The action you started needs your two-factor code again. It continues once you confirm; the page behind stays as you left it.",
    connect: "Connecting a number needs your two-factor code first.",
  },
};

type Open = (reason: StepUpReason | null) => void;

/**
 * The mounted sheets, innermost last. A dialog mounts its own inside itself,
 * so the prompt is nested in the surface the operator is already in rather
 * than opened as a second modal beside it.
 */
const hosts: Open[] = [];
let waiting: { host: Open; resolve: (ok: boolean) => void } | null = null;

/** Answer the prompt that is waiting, if one is, and close its sheet. */
export function settleStepUp(ok: boolean): void {
  const asked = waiting;
  if (!asked) return;
  waiting = null;
  asked.host(null);
  asked.resolve(ok);
}

/**
 * A sheet (`step-up-sheet.tsx`) registers how to show itself and gets back
 * its unregister, which declines the prompt it is showing, if any.
 */
export function registerStepUpPrompt(show: Open): () => void {
  hosts.push(show);
  return () => {
    if (waiting?.host === show) settleStepUp(false);
    const at = hosts.lastIndexOf(show);
    if (at !== -1) hosts.splice(at, 1);
  };
}

/** Ask the operator to enroll or confirm. A newer request declines an older one. */
export function promptStepUp(reason: StepUpReason): Promise<boolean> {
  settleStepUp(false);
  const host = hosts.at(-1);
  if (!host) return Promise.resolve(false);
  host(reason);
  return new Promise<boolean>((resolve) => {
    waiting = { host, resolve };
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
