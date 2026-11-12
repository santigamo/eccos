import { useState, type FormEvent } from "react";
import { authClient } from "../../auth/auth-client";
import { totpSecret, twoFactorErrorMessage } from "../../lib/two-factor";
import { PasswordField } from "../auth/password-field";
import { QrCode } from "./qr-code";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const MACHINE_CLASS = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
const ERROR_CLASS =
  "bg-destructive/10 text-destructive-foreground mt-3 block border border-destructive/20 p-3 text-xs";

interface Setup {
  totpURI: string;
  backupCodes: string[];
}

/**
 * Two-factor authentication (TOTP) for the signed-in user.
 *
 * Sensitive actions require it (contract §4/§8). `returnTo` is the page a
 * refused action came from: the panel says so and goes back there when done.
 * Every control is a ghost: the page's one primary is Create key.
 */
export function TwoFactorPanel({ enabled, returnTo }: { enabled: boolean; returnTo?: string }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [verified, setVerified] = useState(false);

  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">Two-factor authentication</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            {returnTo && !enabled && !verified
              ? "The action you started needs two-factor authentication. Set it up here and you will go back to where you were."
              : "A code from an authenticator app at sign-in. Connecting numbers, API keys and webhook settings require it."}
          </FrameDescription>
        </FrameHeader>
        {verified && setup ? (
          <BackupCodes codes={setup.backupCodes} doneHref={returnTo ?? "/settings"} />
        ) : enabled ? (
          <Enabled returnTo={returnTo} />
        ) : setup ? (
          <VerifyStep totpURI={setup.totpURI} onVerified={() => setVerified(true)} />
        ) : (
          <StartStep onStarted={setSetup} />
        )}
      </FramePanel>
    </Frame>
  );
}

function Enabled({ returnTo }: { returnTo?: string }) {
  return (
    <div className="mt-5">
      <span className={`block ${MACHINE_CLASS}`}>On</span>
      <p className="mt-1.5 mb-0 text-sm text-muted-foreground">
        Sign-ins to this account ask for a code from your authenticator app.
      </p>
      {returnTo ? (
        <a href={returnTo} className={cn("mt-3", buttonVariants({ variant: "outline" }))}>
          Back to where you were
        </a>
      ) : null}
    </div>
  );
}

function StartStep({ onStarted }: { onStarted: (setup: Setup) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.enable({ password }).catch(() => null);
    setBusy(false);
    const data = result?.data;
    if (data?.method !== "totp") {
      setError(
        result?.error?.code === "INVALID_PASSWORD"
          ? twoFactorErrorMessage("INVALID_PASSWORD")
          : "Could not start the setup right now. Please try again.",
      );
      return;
    }
    onStarted({ totpURI: data.totpURI, backupCodes: data.backupCodes });
  }

  return (
    <form onSubmit={onSubmit} aria-busy={busy} className="mt-5 flex max-w-sm flex-col gap-3">
      <PasswordField
        id="two-factor-password"
        label="Your password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        hasError={Boolean(error)}
        errorId={error ? "two-factor-error" : undefined}
      />
      <div>
        <Button type="submit" variant="outline" disabled={busy || !password}>
          {busy ? "Starting…" : "Set up"}
        </Button>
      </div>
      {error ? (
        <output id="two-factor-error" aria-live="polite" className={ERROR_CLASS}>
          {error}
        </output>
      ) : null}
    </form>
  );
}

function VerifyStep({ totpURI, onVerified }: { totpURI: string; onVerified: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.verifyTotp({ code: code.trim() }).catch(() => null);
    setBusy(false);
    if (!result || result.error) {
      setError(
        result
          ? twoFactorErrorMessage(result.error?.code)
          : "Could not verify the code right now. Please try again.",
      );
      return;
    }
    onVerified();
  }

  return (
    <div className="mt-5 flex flex-wrap items-start gap-5">
      <QrCode value={totpURI} label="QR code for your authenticator app" />
      <form onSubmit={onSubmit} aria-busy={busy} className="flex min-w-0 max-w-sm flex-1 flex-col gap-3">
        <p className="m-0 text-sm text-pretty text-muted-foreground">
          Scan the code with an authenticator app, or enter this key by hand.
        </p>
        <code className="font-mono text-xs break-all text-foreground">{totpSecret(totpURI)}</code>
        <div>
          <label htmlFor="two-factor-code" className={`mb-1 block ${MACHINE_CLASS}`}>
            6-digit code
          </label>
          <Input
            id="two-factor-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>
        <div>
          <Button type="submit" variant="outline" disabled={busy || !code.trim()}>
            {busy ? "Verifying…" : "Turn on"}
          </Button>
        </div>
        {error ? (
          <output aria-live="polite" className={ERROR_CLASS}>
            {error}
          </output>
        ) : null}
      </form>
    </div>
  );
}

/** Shown once, after the first code verifies. Exported for direct rendering in tests. */
export function BackupCodes({ codes, doneHref }: { codes: string[]; doneHref: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-5 border border-(--line-strong) bg-(--ghost-fill) p-3">
      <span className={`block ${MACHINE_CLASS}`}>Backup codes</span>
      <ul className="mt-2 mb-0 grid list-none grid-cols-2 gap-x-6 gap-y-1 p-0 font-mono text-xs text-foreground">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <p className="mt-2 mb-0 text-xs text-warning-foreground">
        Two-factor authentication is on. Save these now: each code signs you in once if you lose
        your authenticator, and you won't see them again.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(codes.join("\n")).then(() => setCopied(true))
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        {/* A full navigation: enrolling re-issued the session, so the loaders re-run. */}
        <a href={doneHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          {doneHref === "/settings" ? "Done" : "Continue"}
        </a>
      </div>
    </div>
  );
}
