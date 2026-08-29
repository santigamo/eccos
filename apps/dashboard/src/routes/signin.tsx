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

type SigninSearch = { redirect?: string; error?: string };

export const Route = createFileRoute("/signin")({
  validateSearch: (search: Record<string, unknown>): SigninSearch => {
    const redirect = typeof search.redirect === "string" ? search.redirect : undefined;
    const error = typeof search.error === "string" ? search.error : undefined;
    return {
      ...(redirect && redirect.startsWith("/") ? { redirect } : {}),
      ...(error ? { error } : {}),
    };
  },
  component: SignInPage,
});

function SignInPage() {
  const { redirect: redirectTo, error: searchError } = useSearch({ from: "/signin" });
  const navigate = Route.useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(searchError ?? null);
  const [pending, setPending] = useState(false);

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
      setError(result.error.message ?? "Could not sign in");
      return;
    }
    // Unverified accounts get the generic anti-enumeration treatment from the
    // server; surface the standard verification notice when signaled.
    if ((result.data as { token?: string | null } | null)?.token === null) {
      setError("Verify your email address first, then sign in again.");
      return;
    }
    await navigate({ to: redirectTo ?? "/" });
  }

  return (
    <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
      <Page title="Sign in" kicker="Eccos">
        <div className="mx-auto flex max-w-md flex-col gap-4">
          <Frame variant="default" spacing="lg">
            <FramePanel fit>
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
                    required
                  />
                </label>
                <label
                  htmlFor="signin-password"
                  className="flex flex-col gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
                >
                  Password
                  <Input
                    id="signin-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </label>
                {error ? (
                  <p className="border-l-2 border-[#e03131] bg-[rgba(224,49,49,.12)] px-3 py-2 text-sm text-[#ff7777]" role="alert">
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
            </FramePanel>
          </Frame>
        </div>
      </Page>
    </main>
  );
}
