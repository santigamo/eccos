/**
 * Why a sensitive action was refused for step-up. The one definition, shared
 * by the tenant layer, the dashboard's policy and the browser.
 */
export const STEP_UP_REASONS = ["totp-required", "reauth-required"] as const;

export type StepUpReason = (typeof STEP_UP_REASONS)[number];

export function isStepUpReason(value: unknown): value is StepUpReason {
  return STEP_UP_REASONS.includes(value as StepUpReason);
}
