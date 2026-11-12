import { useState } from "react";

import { authClient } from "@/auth/auth-client";
import { AUTH_ERROR_BANNER_CLASS } from "@/components/auth/auth-page";
import { Logo } from "@/components/blocks/app-shell-7/components/logo";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { twoFactorErrorMessage } from "@/lib/two-factor";
import { ArrowRightIcon } from "lucide-react";
import type { FormSubmitEvent } from "./login-form";

/** The second step of sign-in for an account with two-factor authentication. */
export function TwoFactorForm({ onVerified }: { onVerified: () => void }) {
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormSubmitEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const body = { code: code.trim() };
    const result = await (
      backup ? authClient.twoFactor.verifyBackupCode(body) : authClient.twoFactor.verifyTotp(body)
    ).catch(() => null);
    setPending(false);
    if (!result) {
      setError("Could not verify the code right now. Please try again.");
      return;
    }
    if (result.error) {
      setError(twoFactorErrorMessage(result.error.code));
      return;
    }
    onVerified();
  }

  return (
    <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="text-foreground text-sm font-semibold tracking-[0.18em] uppercase">
            Eccos
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl leading-tight font-semibold text-balance">Two-factor code</h1>
          <p className="text-muted-foreground text-base text-pretty">
            {backup
              ? "Enter one of the backup codes you saved when you set up two-factor authentication. Each works once."
              : "Enter the 6-digit code from your authenticator app."}
          </p>
        </div>
      </div>

      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <Field className="gap-2">
          <FieldLabel
            htmlFor="signin-code"
            className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
          >
            {backup ? "Backup code" : "Code"}
          </FieldLabel>
          <Input
            id="signin-code"
            autoComplete="one-time-code"
            inputMode={backup ? "text" : "numeric"}
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-code-error" : undefined}
          />
        </Field>

        {error ? (
          <p id="signin-code-error" className={AUTH_ERROR_BANNER_CLASS} role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Button type="submit" disabled={pending || !code.trim()}>
            {pending ? "Verifying…" : "Verify"}
            <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
          </Button>
          <button
            type="button"
            className="text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              setBackup((value) => !value);
              setCode("");
              setError(null);
            }}
          >
            {backup ? "Use the authenticator app" : "Use a backup code"}
          </button>
        </div>
      </form>

      <a href="/signin" className="text-muted-foreground text-xs hover:text-foreground">
        Start again
      </a>
    </div>
  );
}
