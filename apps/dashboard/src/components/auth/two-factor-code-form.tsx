import { useState, type FormEvent } from "react";

import { AUTH_ERROR_BANNER_CLASS } from "@/components/auth/auth-page";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MACHINE_CLASS } from "@/ui";
import { ArrowRightIcon } from "lucide-react";

/**
 * The authenticator code, or a backup code. `verify` says what the code is
 * checked against (a sign-in's challenge, or the current session for step-up)
 * and returns the message to show, or null when it passed.
 */
export function TwoFactorCodeForm({
  verify,
  onVerified,
}: {
  verify: (code: string, backup: boolean) => Promise<string | null>;
  onVerified: () => void;
}) {
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const refusal = await verify(code.trim(), backup);
    setPending(false);
    if (refusal) setError(refusal);
    else onVerified();
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
      <p className="text-muted-foreground m-0 text-sm text-pretty">
        {backup
          ? "Enter one of the backup codes you saved when you set up two-factor authentication. Each works once."
          : "Enter the 6-digit code from your authenticator app."}
      </p>
      <Field className="gap-2">
        <FieldLabel htmlFor="two-factor-code" className={MACHINE_CLASS}>
          {backup ? "Backup code" : "Code"}
        </FieldLabel>
        <Input
          id="two-factor-code"
          autoComplete="one-time-code"
          inputMode={backup ? "text" : "numeric"}
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "two-factor-code-error" : undefined}
        />
      </Field>

      {error ? (
        <p id="two-factor-code-error" className={AUTH_ERROR_BANNER_CLASS} role="alert">
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
  );
}
