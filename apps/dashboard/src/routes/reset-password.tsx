import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../auth/auth-client";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";
import { Page } from "../ui";

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

function ResetPasswordPage() {
  const { token, error: searchError } = useSearch({ from: "/reset-password" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(searchError ?? null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

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
      setError(result.error.message ?? "Could not reset the password");
      return;
    }
    setDone(true);
  }

  return (
    <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
      <Page title="Set a new password" kicker="Eccos">
        <div className="mx-auto flex max-w-md flex-col gap-4">
          <Frame variant="default" spacing="lg">
            <FramePanel fit>
              {done ? (
                <>
                  <FrameHeader>
                    <FrameTitle>Password updated</FrameTitle>
                    <FrameDescription>
                      Your password has been changed. Sign in with the new one.
                    </FrameDescription>
                  </FrameHeader>
                  <a href="/signin" className="text-muted-foreground text-sm hover:text-foreground">
                    Go to sign in
                  </a>
                </>
              ) : !token ? (
                <>
                  <FrameHeader>
                    <FrameTitle>Missing reset token</FrameTitle>
                    <FrameDescription>
                      This page needs the link from your reset email. Request a new
                      one from the forgot-password page.
                    </FrameDescription>
                  </FrameHeader>
                  <a href="/forgot-password" className="text-muted-foreground text-sm hover:text-foreground">
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
                    <label
                      htmlFor="reset-password"
                      className="flex flex-col gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
                    >
                      New password
                      <Input
                        id="reset-password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </label>
                    <label
                      htmlFor="reset-confirm"
                      className="flex flex-col gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
                    >
                      Confirm password
                      <Input
                        id="reset-confirm"
                        type="password"
                        value={confirm}
                        onChange={(event) => setConfirm(event.target.value)}
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </label>
                    {error ? (
                      <p className="border-l-2 border-[#e03131] bg-[rgba(224,49,49,.12)] px-3 py-2 text-sm text-[#ff7777]" role="alert">
                        {error}
                      </p>
                    ) : null}
                    <Button type="submit" disabled={pending}>
                      {pending ? "Updating…" : "Update password"}
                    </Button>
                  </form>
                </>
              )}
            </FramePanel>
          </Frame>
        </div>
      </Page>
    </main>
  );
}
