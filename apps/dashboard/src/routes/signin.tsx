import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authClient } from "../auth/auth-client";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  FrameDescription,
  FrameHeader,
  FrameTitle,
} from "../components/reui/frame";
import {
  AUTH_ERROR_BANNER_CLASS,
  AuthCard,
  authErrorMessage,
  safeRedirectTarget,
} from "../components/auth/auth-page";
import { PasswordField } from "../components/auth/password-field";

type SigninSearch = { redirect?: string; error?: string };

export const Route = createFileRoute("/signin")({
  validateSearch: (search: Record<string, unknown>): SigninSearch => {
    const redirect = safeRedirectTarget(
      typeof search.redirect === "string" ? search.redirect : undefined,
    );
    const error = typeof search.error === "string" ? search.error : undefined;
    return {
      ...(redirect ? { redirect } : {}),
      ...(error ? { error } : {}),
    };
  },
  component: SignInPage,
});

function SignInPage() {
  const { redirect: rawRedirect, error: searchError } = useSearch({ from: "/signin" });
  // Re-validate: useSearch can also feed from internal navigation states.
  const redirectTo = safeRedirectTarget(rawRedirect);
  const navigate = Route.useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(searchError ?? null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    document.title = "Sign in — Eccos";
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authClient.signIn.email({
      email,
      password,
      callbackURL: redirectTo ?? "/",
    });
    setPending(false);
    if (result.error) {
      // Anti-enumeration: EMAIL_NOT_VERIFIED maps to the verification notice;
      // other errors render a bounded message, never raw server text.
      setError(authErrorMessage(result.error, "Could not sign in"));
      return;
    }
    // Unverified accounts also surface as 200-with-null-token on some flows;
    // keep the generic verification notice for that variant too.
    if ((result.data as { token?: string | null } | null)?.token === null) {
      setError("Verify your email address first, then sign in again.");
      return;
    }
    // href navigation preserves query-string targets like /inbound?wabaId=...
    await navigate({ href: redirectTo ?? "/" });
  }

  return (
    <AuthCard title="Sign in">
      <FrameHeader>
        <FrameTitle>Sign in to your workspace</FrameTitle>
        <FrameDescription>
          Use your Eccos account email and password.
        </FrameDescription>
      </FrameHeader>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label
          htmlFor="signin-email"
          className="flex flex-col gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
        >
          Email
          <Input
            id="signin-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-error" : undefined}
            required
          />
        </label>
        <PasswordField
          id="signin-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          errorId={error ? "signin-error" : undefined}
          hasError={Boolean(error)}
        />
        {error ? (
          <p id="signin-error" className={AUTH_ERROR_BANNER_CLASS} role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
          <a
            href="/forgot-password"
            className="text-muted-foreground text-xs hover:text-foreground"
          >
            Forgot password?
          </a>
        </div>
      </form>
    </AuthCard>
  );
}
