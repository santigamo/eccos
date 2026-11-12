/** Bounded copy per two-factor refusal: never the provider's raw message. */
export function twoFactorErrorMessage(code: string | undefined): string {
  switch (code) {
    case "INVALID_PASSWORD":
      return "That password is not right.";
    case "INVALID_TWO_FACTOR_COOKIE":
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      return "This sign-in expired. Start again with your password.";
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return "Too many wrong codes. Wait 15 minutes, then try again.";
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
