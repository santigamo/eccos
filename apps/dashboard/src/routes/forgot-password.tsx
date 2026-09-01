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
  AddressReadback,
  AuthCard,
  authErrorMessage,
  AUTH_ERROR_BANNER_CLASS,
} from "../components/auth/auth-page";
import { AUTH_LINK_EXPIRY_LABEL } from "../auth/mail";

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
  // Submitting used to navigate to ?sent=1, which threw the typed address away
  // on the reload — so the screen could not read it back. It stays in state
  // instead. The search param is still honoured for an old bookmarked link;
  // that path simply has no address to show, and the address NEVER travels in
  // the URL (it is personal data, and query strings are logged everywhere).
  const [submitted, setSubmitted] = useState(false);
  const [sentEmail, setSentEmail] = useState("");
  const showSent = submitted || Boolean(sent);

  useEffect(() => {
    document.title = showSent ? "Check your inbox · Eccos" : "Forgot password · Eccos";
  }, [showSent]);

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
    setSentEmail(email);
    setSubmitted(true);
  }

  return (
    <AuthCard title="Reset your password">
      {showSent ? (
        <>
          <FrameHeader>
            <FrameTitle>Check your inbox</FrameTitle>
            <FrameDescription>
              If that address exists in our system, a reset link is on its way
              and is valid for {AUTH_LINK_EXPIRY_LABEL}.
            </FrameDescription>
          </FrameHeader>
          {/* "You entered", never "Sent to": this screen must not confirm that
              an account exists (contract §8), and "sent" would. Reading the
              address back is still worth it — a typo is the reader's own most
              likely mistake, and it is the one they can fix. */}
          {sentEmail ? (
            <AddressReadback label="You entered" email={sentEmail} />
          ) : null}
          {/* FramePanel is plain block flow, not a flex column with a gap:
              the readback above ends flush, so the link carries its own top
              margin (and `inline-block` for the margin to apply at all). */}
          <a
            href="/signin"
            className="text-muted-foreground mt-4 inline-block text-sm hover:text-foreground"
          >
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
