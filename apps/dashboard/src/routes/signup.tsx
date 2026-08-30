import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
  isDuplicateEmailError,
} from "../components/auth/auth-page";
import { PasswordField } from "../components/auth/password-field";

type SignupSearch = { error?: string };

export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): SignupSearch => {
    const error = typeof search.error === "string" ? redactError(search.error) : undefined;
    return error ? { error } : {};
  },
  component: SignUpPage,
});

/**
 * Pure helper: ?error= carries only a bounded generic message, never raw
 * server text that could confirm whether an address exists.
 */
export function redactError(value: string): string | undefined {
  return value && value.length < 200 ? value : undefined;
}

function SignUpPage() {
  const { error: searchError } = useSearch({ from: "/signup" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(searchError ? "Could not sign up" : null);
  const [sent, setSent] = useState(false);
  const [sentEmail, setSentEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [resendPending, setResendPending] = useState(false);
  const [resendNote, setResendNote] = useState<string | null>(null);
  const sentHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = "Create your account — Eccos";
  }, []);

  // Move focus and announce the swap for assistive tech (eccos-qde).
  useEffect(() => {
    if (sent) sentHeadingRef.current?.focus();
  }, [sent]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: "/",
    });
    setPending(false);
    if (result.error && !isDuplicateEmailError(result.error)) {
      setError(authErrorMessage(result.error, "Could not sign up"));
      return;
    }
    // Anti-enumeration: duplicate email and success take the SAME path.
    setSentEmail(email);
    setSent(true);
  }

  async function onResend() {
    // Anti-enumeration: always claim success, never confirm whether the
    // address is registered or already verified. Core endpoint POST
    // /send-verification-email (better-auth 1.7.2); $fetch is the client's
    // typed escape hatch — the endpoint is not exposed as a namespaced
    // action by this client configuration's type inference.
    setResendPending(true);
    setResendNote(null);
    await authClient.$fetch("/send-verification-email", {
      method: "POST",
      body: { email: sentEmail, callbackURL: "/" },
    });
    setResendPending(false);
    setResendNote("Verification email sent again.");
  }

  return (
    <AuthCard title="Create your account">
      {sent ? (
        <>
          <FrameHeader>
            <FrameTitle ref={sentHeadingRef} tabIndex={-1}>
              Check your inbox
            </FrameTitle>
            <FrameDescription>
              We sent a verification link to {sentEmail}. Verify your address,
              then sign in. The link expires after a limited time.
            </FrameDescription>
          </FrameHeader>
          <div role="status" className="flex flex-col gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={resendPending}
              onClick={() => void onResend()}
            >
              {resendPending ? "Sending…" : "Resend verification email"}
            </Button>
            {resendNote ? (
              <p className="text-muted-foreground text-xs">{resendNote}</p>
            ) : null}
            <a href="/signin" className="text-muted-foreground text-sm hover:text-foreground">
              Back to sign in
            </a>
          </div>
        </>
      ) : (
        <>
          <FrameHeader>
            <FrameTitle>Create your account</FrameTitle>
            <FrameDescription>
              You will need to verify your email before using Eccos.
            </FrameDescription>
          </FrameHeader>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <label
              htmlFor="signup-name"
              className="flex flex-col gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
            >
              Name
              <Input
                id="signup-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                required
              />
            </label>
            <label
              htmlFor="signup-email"
              className="flex flex-col gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
            >
              Email
              <Input
                id="signup-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "signup-error" : undefined}
                required
              />
            </label>
            <PasswordField
              id="signup-password"
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              minLength={10}
              errorId={error ? "signup-error" : undefined}
              hasError={Boolean(error)}
              required
            />
            {error ? (
              <p id="signup-error" className={AUTH_ERROR_BANNER_CLASS} role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}
