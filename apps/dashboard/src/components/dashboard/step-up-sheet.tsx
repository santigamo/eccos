import { useRouter } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { authClient } from "../../auth/auth-client";
import { invalidateRoutes, rootRouteId } from "../../lib/invalidate";
import { registerStepUpPrompt, type StepUpReason } from "../../lib/step-up";
import { twoFactorErrorMessage } from "../../lib/two-factor";
import { ERROR_CLASS } from "../../ui";
import { PasswordField } from "../auth/password-field";
import { TwoFactorCodeForm } from "../auth/two-factor-code-form";
import { TwoFactorSetup } from "./two-factor";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface Pending {
  reason: StepUpReason;
  settle: (ok: boolean) => void;
}

const COPY: Record<StepUpReason, { title: string; description: string }> = {
  "totp-required": {
    title: "Set up two-factor authentication",
    description:
      "The action you started needs it. Set it up here and the action continues; the page behind stays as you left it.",
  },
  "reauth-required": {
    title: "Confirm it's you",
    description:
      "The action you started needs your password and two-factor code again. It continues once you confirm; the page behind stays as you left it.",
  },
};

/**
 * The step-up prompt (task register): the form a refused sensitive action
 * needs, beside the page it was started on. Mounted once in the shell; call
 * sites reach it through `withStepUp`.
 */
export function StepUpSheet({ email }: { email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  // Backup codes are on screen and cannot be shown again: only Done leaves.
  const [locked, setLocked] = useState(false);

  useEffect(
    () =>
      registerStepUpPrompt(
        (reason) => new Promise<boolean>((settle) => setPending({ reason, settle })),
      ),
    [],
  );

  function finish(ok: boolean) {
    pending?.settle(ok);
    // The shell's own view of the user (enrolled or not) is now out of date.
    if (ok && pending?.reason === "totp-required") void invalidateRoutes(router, rootRouteId);
    setPending(null);
    setLocked(false);
  }

  const copy = pending ? COPY[pending.reason] : null;
  return (
    <Sheet
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !locked) finish(false);
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={!locked}
        className="gap-2 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
      >
        <SheetHeader className="gap-2">
          <SheetTitle>{copy?.title}</SheetTitle>
          <SheetDescription>{copy?.description}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {pending?.reason === "totp-required" ? (
            <TwoFactorSetup onEnrolled={() => setLocked(true)} onDone={() => finish(true)} />
          ) : pending ? (
            <Reauthenticate email={email} onVerified={() => finish(true)} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * A full sign-in in place: the password, then the second factor. Only that
 * path stamps the session as stepped up, and only it limits wrong codes.
 */
function Reauthenticate({ email, onVerified }: { email: string; onVerified: () => void }) {
  const [password, setPassword] = useState("");
  const [challenged, setChallenged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.email({ email, password }).catch(() => null);
    setBusy(false);
    if (!result || result.error) {
      setError(
        result?.error?.code === "INVALID_EMAIL_OR_PASSWORD"
          ? twoFactorErrorMessage("INVALID_PASSWORD")
          : "Could not confirm right now. Please try again.",
      );
      return;
    }
    if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setChallenged(true);
      return;
    }
    onVerified();
  }

  if (challenged) return <TwoFactorCodeForm onVerified={onVerified} />;
  return (
    <form onSubmit={onSubmit} aria-busy={busy} className="flex flex-col gap-3">
      <PasswordField
        id="step-up-password"
        label="Your password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        hasError={Boolean(error)}
        errorId={error ? "step-up-error" : undefined}
      />
      <div>
        <Button type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </div>
      {error ? (
        <output id="step-up-error" aria-live="polite" className={ERROR_CLASS}>
          {error}
        </output>
      ) : null}
    </form>
  );
}
