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
import { AUTH_LINK_EXPIRY_LABEL } from "@/auth/mail";
import {
  AddressReadback,
  AUTH_ERROR_BANNER_CLASS,
  mailUndeliverableMessage,
  ResendNote,
  type ResendOutcome,
  resendVerificationOutcome,
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
  const [resendOutcome, setResendOutcome] = useState<ResendOutcome | null>(null);
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
      // An address the mail provider says definitively cannot receive mail
      // (eccos-3ne). Surfacing it here is safe: an existing account
      // short-circuits above, so this is about a freshly typed address, not
      // about membership — and the dominant cause is the user's own typo,
      // which only they can fix. Without this branch the message collapses
      // into the generic failure and the person is told to try again with the
      // same unreachable address.
      const undeliverable = mailUndeliverableMessage(result.error);
      if (undeliverable) {
        setError(undeliverable);
        return;
      }
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
    // Anti-enumeration: an answered request always claims success, never
    // confirming whether the address is registered or already verified. The one
    // status that changes the wording is 429 — the resend rate limit
    // (auth.ts customRules), which is about this caller, not this address.
    // Reporting it is what keeps the button honest: it did not send, so the
    // screen must not say it did (eccos-hk5).
    setResendPending(true);
    setResendOutcome(null);
    let status: number | null = null;
    try {
      const result = await authClient.$fetch("/send-verification-email", {
        method: "POST",
        body: { email: sentEmail, callbackURL: "/" },
      });
      // better-fetch resolves with { data, error } instead of throwing; an
      // answered request has a status either way, and only a transport failure
      // (below) leaves us without one.
      status = result.error?.status ?? 200;
    } catch {
      status = null;
    }
    setResendPending(false);
    setResendOutcome(resendVerificationOutcome(status));
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
                {/* The address is NOT named here: it renders below as a datum
                    the reader can check character by character (AddressReadback).
                    Naming it in both places would say it twice — and this
                    element is the live region, so it would also be announced
                    twice. */}
                <output
                  aria-live="polite"
                  aria-atomic="true"
                  className="text-muted-foreground block text-base text-pretty"
                >
                  We sent you a verification link. Open it to verify your
                  address, then sign in — the link is valid for{" "}
                  {AUTH_LINK_EXPIRY_LABEL}.
                </output>
              </div>
              <AddressReadback label="Sent to" email={sentEmail} />
            </div>
            {/* Explicit margins instead of a flex `gap`: the resend note's live
                region stays mounted while empty (so it can announce), and a gap
                would reserve space for it even when it has nothing to say. */}
            <div className="flex flex-col">
              <Button
                type="button"
                variant="outline"
                disabled={resendPending}
                onClick={() => void onResend()}
              >
                {resendPending ? "Sending…" : "Resend verification email"}
              </Button>
              <ResendNote outcome={resendOutcome} />
              <a
                href="/signin"
                className="text-muted-foreground mt-4 text-sm hover:text-foreground"
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
