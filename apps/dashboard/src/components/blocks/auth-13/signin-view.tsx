import { useEffect, useState } from "react";
import { authClient } from "@/auth/auth-client";
import { AuthSplitShell } from "./components/auth";
import { LoginForm, type FormSubmitEvent } from "./components/login-form";
import { authErrorMessage } from "@/components/auth/auth-page";
import { validateEmail } from "./components/validation";

/**
 * Sign-in view on the reui auth-13 split-screen skeleton, adapted to the
 * Eccos design contract. The owning route validates the redirect target and
 * passes it in; this view owns form state and the auth call.
 */
export function SignInView({
  redirectTo,
  searchError,
}: {
  redirectTo: string;
  searchError: string | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(searchError);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  useEffect(() => {
    document.title = "Sign in · Eccos";
  }, []);

  function clearField(key: string) {
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: null } : prev));
  }

  async function onSubmit(event: FormSubmitEvent) {
    event.preventDefault();
    const errors: Record<string, string | null> = {
      email: validateEmail(email),
      password: password ? null : "Enter your password",
    };
    if (Object.values(errors).some(Boolean)) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setPending(true);
    setError(null);
    let result: Awaited<ReturnType<typeof authClient.signIn.email>>;
    try {
      result = await authClient.signIn.email({
        email,
        password,
        callbackURL: redirectTo || "/",
      });
    } catch {
      // Thrown client failure (network, non-JSON 5xx): reset pending and show
      // a generic error instead of a stuck button.
      setPending(false);
      setError("Could not sign in right now. Please try again.");
      return;
    }
    setPending(false);
    if (result.error) {
      // Anti-enumeration: EMAIL_NOT_VERIFIED maps to the verification
      // notice; other errors render a bounded message, never raw server text.
      setError(authErrorMessage(result.error, "Could not sign in"));
      return;
    }
    if ((result.data as { token?: string | null } | null)?.token === null) {
      setError("Verify your email address first, then sign in again.");
      return;
    }
    // Full navigation so the root loader re-resolves the fresh session; a
    // full URL assignment preserves query-string targets like /inbound?wabaId=.
    window.location.assign(redirectTo || "/");
  }

  return (
    <AuthSplitShell>
      <LoginForm
        onSubmit={onSubmit}
        error={error}
        pending={pending}
        email={email}
        password={password}
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
      />
    </AuthSplitShell>
  );
}
