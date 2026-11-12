/**
 * The operator's side of step-up: a sensitive call refused for it is resolved
 * in place and run once more. Nothing navigates, so the page and whatever was
 * typed into it stay as they were.
 */

export type StepUpReason = "totp-required" | "reauth-required";

type Prompt = (reason: StepUpReason) => Promise<boolean>;

let prompt: Prompt | null = null;

/** The mounted prompt (`step-up-sheet.tsx`) registers itself; returns its unregister. */
export function registerStepUpPrompt(next: Prompt): () => void {
  prompt = next;
  return () => {
    if (prompt === next) prompt = null;
  };
}

function stepUpReason(result: { reason?: string }): StepUpReason | null {
  return result.reason === "totp-required" || result.reason === "reauth-required"
    ? result.reason
    : null;
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
  const reason = first.ok ? null : stepUpReason(first);
  if (!reason || !prompt || !(await prompt(reason))) return first;
  return call();
}
