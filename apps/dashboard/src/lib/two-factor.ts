/** A check that failed for a reason that says nothing about the code. */
export const VERIFY_UNAVAILABLE = "Could not verify the code right now. Please try again.";

/** Too many wrong codes. `minutes` is the server's own wait, when it said. */
export function lockedMessage(minutes?: number): string {
  const wait = minutes === undefined ? "a few minutes" : minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return `Too many wrong codes. Wait ${wait}, then try again.`;
}

/** Bounded copy per two-factor refusal: never the provider's raw message. */
export function twoFactorErrorMessage(code: string | undefined): string {
  switch (code) {
    case "INVALID_PASSWORD":
      return "That password is not right.";
    case "INVALID_TWO_FACTOR_COOKIE":
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      return "This sign-in expired. Start again with your password.";
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return lockedMessage();
    default:
      return "That code did not match. Check it and try again.";
  }
}

/** The secret inside an `otpauth://` URI, for typing into an app that cannot scan. */
export function totpSecret(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}
