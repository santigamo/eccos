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
import { AuthCard, authErrorMessage, AUTH_ERROR_BANNER_CLASS } from "../components/auth/auth-page";

type ForgotSearch = { error?: string; sent?: string };

export const Route = createFileRoute("/forgot-password")({
  validateSearch: (search: Record<string, unknown>): ForgotSearch => {
    const error = typeof search.error === "string" ? search.error : undefined;
    const sent = typeof search.sent === "string" ? search.sent : undefined;
    return {
      ...(error ? { error } : {}),
      ...(sent ? { sent } : {}),
    };
  },
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { sent } = useSearch({ from: "/forgot-password" });
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    document.title = sent ? "Check your inbox · Eccos" : "Forgot password · Eccos";
  }, [sent]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setPending(false);
    if (result.error) {
      setError(authErrorMessage(result.error, "Could not start the reset"));
      return;
    }
    // Generic response either way (anti-enumeration, contract §8).
    window.location.assign("/forgot-password?sent=1");
  }

  return (
    <AuthCard title="Reset your password">
      {sent ? (
        <>
          <FrameHeader>
            <FrameTitle>Check your inbox</FrameTitle>
            <FrameDescription>
              If that address exists in our system, a reset link is on its
              way. The link expires after a limited time.
            </FrameDescription>
          </FrameHeader>
          <a href="/signin" className="text-muted-foreground text-sm hover:text-foreground">
            Back to sign in
          </a>
        </>
      ) : (
        <>
          <FrameHeader>
            <FrameTitle>Forgot your password?</FrameTitle>
            <FrameDescription>
              Enter your account email and we will send a reset link.
            </FrameDescription>
          </FrameHeader>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <label
              htmlFor="forgot-email"
              className="flex flex-col gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
            >
              Email
              <Input
                id="forgot-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "forgot-error" : undefined}
                required
              />
            </label>
            {error ? (
              <p id="forgot-error" className={AUTH_ERROR_BANNER_CLASS} role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}
