import { useEffect, useState } from "react";
import { authClient } from "@/auth/auth-client";
import { AuthSplitShell } from "./components/auth";
import { LoginForm, type FormSubmitEvent } from "./components/login-form";
import { authErrorMessage } from "@/components/auth/auth-page";

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

  useEffect(() => {
    document.title = "Sign in · Eccos";
  }, []);

  async function onSubmit(event: FormSubmitEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authClient.signIn.email({
      email,
      password,
      callbackURL: redirectTo || "/",
    });
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
