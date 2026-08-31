import { useEffect, useRef, useState } from "react";
import { authClient } from "@/auth/auth-client";
import { AuthSplitShell } from "./components/auth";
import { Logo } from "@/components/blocks/app-shell-7/components/logo";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  AUTH_ERROR_BANNER_CLASS,
} from "@/components/auth/auth-page";
import { PasswordField } from "@/components/auth/password-field";
import {
  validateEmail,
  validateName,
  validatePassword,
} from "./components/validation";
import type { FormSubmitEvent } from "./components/login-form";

/**
 * Sign-up view on the reui auth-13 split-screen skeleton, adapted to the
 * Eccos design contract (same shell as sign-in — machine-voice labels, the
 * real email+password flow, anti-enumeration posture, no external images).
 */
export function SignUpView() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [sentEmail, setSentEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [resendPending, setResendPending] = useState(false);
  const [resendNote, setResendNote] = useState<string | null>(null);
  const sentHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = "Create your account · Eccos";
  }, []);

  // Move focus and announce the swap for assistive tech.
  useEffect(() => {
    if (sent) sentHeadingRef.current?.focus();
  }, [sent]);

  async function onSubmit(event: FormSubmitEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    let result: Awaited<ReturnType<typeof authClient.signUp.email>>;
    try {
      result = await authClient.signUp.email({
        name,
        email,
        password,
        callbackURL: "/",
      });
    } catch {
      // Thrown client failure (network, non-JSON 5xx): reset pending and show
      // a generic error instead of a stuck button.
      setPending(false);
      setError("Could not sign up right now. Please try again.");
      return;
    }
    setPending(false);
    // Anti-enumeration: duplicate email and success take the SAME path.
    if (
      result.error &&
      result.error.code !== "USER_ALREADY_EXISTS" &&
      result.error.status !== 422
    ) {
      setError(
        result.error.message && result.error.message.length < 200
          ? result.error.message
          : "Could not sign up",
      );
      return;
    }
    setSentEmail(email);
    setSent(true);
  }

  async function onResend() {
    // Anti-enumeration: always claim success, never confirm whether the
    // address is registered or already verified.
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
    <AuthSplitShell>
      <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-8">
        {sent ? (
          <>
            <div className="flex flex-col gap-6">
              <div className="flex items-center gap-3">
                <Logo />
                <span className="text-foreground text-sm font-semibold tracking-[0.18em] uppercase">
                  Eccos
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <h1
                  ref={sentHeadingRef}
                  tabIndex={-1}
                  className="text-3xl leading-tight font-semibold text-balance focus-visible:outline-none"
                >
                  Check your inbox
                </h1>
                {/* <output> is the console's live-region element (see
                    numbers-table / connect-outcome): it maps to role="status"
                    but is inline by default, so it carries `block` to keep the
                    paragraph box it replaces. */}
                <output
                  aria-live="polite"
                  aria-atomic="true"
                  className="text-muted-foreground block text-base text-pretty"
                >
                  We sent a verification link to {sentEmail}. Verify your
                  address, then sign in. The link expires after a limited time.
                </output>
              </div>
            </div>
            <div className="flex flex-col gap-4">
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
              <a
                href="/signin"
                className="text-muted-foreground text-sm hover:text-foreground"
              >
                Back to sign in
              </a>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-6">
              <div className="flex items-center gap-3">
                <Logo />
                <span className="text-foreground text-sm font-semibold tracking-[0.18em] uppercase">
                  Eccos
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <h1 className="text-3xl leading-tight font-semibold text-balance">
                  Create your account
                </h1>
                <p className="text-muted-foreground text-base text-pretty">
                  You will need to verify your email before using Eccos.
                </p>
              </div>
            </div>

            <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
              <FieldGroup className="gap-4">
                <Field className="gap-2">
                  <FieldLabel
                    htmlFor="signup-name"
                    className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
                  >
                    Name
                  </FieldLabel>
                  <Input
                    id="signup-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    required
                  />
                </Field>
                <Field className="gap-2">
                  <FieldLabel
                    htmlFor="signup-email"
                    className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
                  >
                    Email
                  </FieldLabel>
                  <Input
                    id="signup-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "signup-error" : undefined}
                    required
                  />
                </Field>
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
              </FieldGroup>

              {error ? (
                <p
                  id="signup-error"
                  className={AUTH_ERROR_BANNER_CLASS}
                  role="alert"
                >
                  {error}
                </p>
              ) : null}

              <Button type="submit" disabled={pending} className="w-full">
                {pending ? "Creating account…" : "Create account"}
              </Button>
            </form>

            <div className="text-muted-foreground text-sm">
              Already have an account?{" "}
              <a
                href="/signin"
                className="text-foreground underline-offset-4 hover:underline"
              >
                Sign in
              </a>
            </div>
          </>
        )}
      </div>
    </AuthSplitShell>
  );
}
