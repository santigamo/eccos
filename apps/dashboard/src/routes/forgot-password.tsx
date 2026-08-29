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
      setError(result.error.message ?? "Could not start the reset");
      return;
    }
    // Generic response either way (anti-enumeration, contract §8).
    window.location.assign("/forgot-password?sent=1");
  }

  return (
    <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
      <Page title="Reset your password" kicker="Eccos">
        <div className="mx-auto flex max-w-md flex-col gap-4">
          <Frame variant="default" spacing="lg">
            <FramePanel fit>
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
                        required
                      />
                    </label>
                    {error ? (
                      <p className="border-l-2 border-[#e03131] bg-[rgba(224,49,49,.12)] px-3 py-2 text-sm text-[#ff7777]" role="alert">
                        {error}
                      </p>
                    ) : null}
                    <Button type="submit" disabled={pending}>
                      {pending ? "Sending…" : "Send reset link"}
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
