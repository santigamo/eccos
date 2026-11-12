import { useId, useState, type FormEvent } from "react";

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
  enrolling = false,
}: {
  verify: (code: string, backup: boolean) => Promise<string | null>;
  onVerified: () => void;
  /** The first code of an enrollment: no backup codes exist yet, and the
   * button is a ghost because it sits on a page with its own primary. */
  enrolling?: boolean;
}) {
  // Not a fixed id: Settings and the step-up sheet can both be on screen.
  const id = useId();
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
        <FieldLabel htmlFor={id} className={MACHINE_CLASS}>
          {backup ? "Backup code" : "Code"}
        </FieldLabel>
        <Input
          id={id}
          autoComplete="one-time-code"
          inputMode={backup ? "text" : "numeric"}
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </Field>

      {error ? (
        <p id={`${id}-error`} className={AUTH_ERROR_BANNER_CLASS} role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Button
          type="submit"
          variant={enrolling ? "outline" : "default"}
          disabled={pending || !code.trim()}
        >
          {pending ? "Verifying…" : enrolling ? "Turn on" : "Verify"}
          {enrolling ? null : <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />}
        </Button>
        {enrolling ? null : (
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
        )}
      </div>
    </form>
  );
}
