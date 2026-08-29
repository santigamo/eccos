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

type SignupSearch = { error?: string };

export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): SignupSearch => {
    const error = typeof search.error === "string" ? search.error : undefined;
    return error ? { error } : {};
  },
  component: SignUpPage,
});

function SignUpPage() {
  const { error: searchError } = useSearch({ from: "/signup" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(searchError ?? null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

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
    if (result.error) {
      setError(result.error.message ?? "Could not sign up");
      return;
    }
    // Anti-enumeration: same success path whether or not the address existed.
    setSent(true);
  }

  return (
    <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
      <Page title="Create your account" kicker="Eccos">
        <div className="mx-auto flex max-w-md flex-col gap-4">
          <Frame variant="default" spacing="lg">
            <FramePanel fit>
              {sent ? (
                <>
                  <FrameHeader>
                    <FrameTitle>Check your inbox</FrameTitle>
                    <FrameDescription>
                      We sent a verification link to {email}. Verify your address,
                      then sign in. The link expires after a limited time.
                    </FrameDescription>
                  </FrameHeader>
                  <a href="/signin" className="text-muted-foreground text-sm hover:text-foreground">
                    Back to sign in
                  </a>
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
                        required
                      />
                    </label>
                    <label
                      htmlFor="signup-password"
                      className="flex flex-col gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
                    >
                      Password
                      <Input
                        id="signup-password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
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
                      {pending ? "Creating account…" : "Create account"}
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
