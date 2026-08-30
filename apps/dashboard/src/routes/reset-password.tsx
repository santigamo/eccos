import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../auth/auth-client";
import { Button } from "../components/ui/button";
import {
  FrameDescription,
  FrameHeader,
  FrameTitle,
} from "../components/reui/frame";
import { AuthCard, authErrorMessage, AUTH_ERROR_BANNER_CLASS } from "../components/auth/auth-page";
import { PasswordField } from "../components/auth/password-field";

type ResetSearch = { token?: string; error?: string };

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): ResetSearch => {
    const token = typeof search.token === "string" ? search.token : undefined;
    const error = typeof search.error === "string" ? search.error : undefined;
    return {
      ...(token ? { token } : {}),
      ...(error ? { error } : {}),
    };
  },
  component: ResetPasswordPage,
});

/** Token errors Better Auth returns for stale/invalid reset tokens. */
const TOKEN_ERROR_CODES = new Set(["INVALID_TOKEN", "TOKEN_EXPIRED"]);

function ResetPasswordPage() {
  const { token, error: searchError } = useSearch({ from: "/reset-password" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(searchError ?? null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [staleToken, setStaleToken] = useState(false);
  const doneHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = done ? "Password updated — Eccos" : "Set a new password — Eccos";
  }, [done]);

  // Announce the success swap for assistive tech (eccos-qde).
  useEffect(() => {
    if (done) doneHeadingRef.current?.focus();
  }, [done]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setPending(true);
    setError(null);
    const result = await authClient.resetPassword({
      newPassword: password,
      token: token ?? "",
    });
    setPending(false);
    if (result.error) {
      // There is no token-verify endpoint in better-auth 1.7.2, so a stale
      // token surfaces here: render the stale-token state instead of a bare
      // error, with the request-new-link action one click away.
      const code = (result.error as { code?: string } | null)?.code;
      if (code && TOKEN_ERROR_CODES.has(code)) {
        setStaleToken(true);
        return;
      }
      setError(authErrorMessage(result.error, "Could not reset the password"));
      return;
    }
    setDone(true);
  }

  return (
    <AuthCard title="Set a new password">
      {done ? (
        <>
          <FrameHeader>
            <FrameTitle ref={doneHeadingRef} tabIndex={-1}>
              Password updated
            </FrameTitle>
            <FrameDescription>
              Your password has been changed. Sign in with the new one.
            </FrameDescription>
          </FrameHeader>
          <div role="status">
            <a href="/signin" className="text-primary text-sm underline-offset-4 hover:underline">
              Go to sign in
            </a>
          </div>
        </>
      ) : staleToken || !token ? (
        <>
          <FrameHeader>
            <FrameTitle>
              {staleToken ? "Reset link expired" : "Missing reset token"}
            </FrameTitle>
            <FrameDescription>
              {staleToken
                ? "That reset link is invalid or has expired. Request a new one — links expire after a limited time."
                : "This page needs the link from your reset email. Request a new one from the forgot-password page."}
            </FrameDescription>
          </FrameHeader>
          <a href="/forgot-password" className="text-primary text-sm underline-offset-4 hover:underline">
            Request a new link
          </a>
        </>
      ) : (
        <>
          <FrameHeader>
            <FrameTitle>Set a new password</FrameTitle>
            <FrameDescription>
              Choose a strong password for your account.
            </FrameDescription>
          </FrameHeader>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <PasswordField
              id="reset-password"
              label="New password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              minLength={10}
              errorId={error ? "reset-error" : undefined}
              hasError={Boolean(error)}
              required
            />
            <PasswordField
              id="reset-confirm"
              label="Confirm password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              minLength={10}
              errorId={error ? "reset-error" : undefined}
              hasError={Boolean(error)}
              required
            />
            {error ? (
              <p id="reset-error" className={AUTH_ERROR_BANNER_CLASS} role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? "Updating…" : "Update password"}
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}
