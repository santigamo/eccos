import { useId, useState, type FormEvent } from "react";
import { authClient } from "../../auth/auth-client";
import { totpSecret, twoFactorErrorMessage } from "../../lib/two-factor";
import { ERROR_CLASS, MACHINE_CLASS } from "../../ui";
import { PasswordField } from "../auth/password-field";
import { TwoFactorCodeForm } from "../auth/two-factor-code-form";
import { QrCode } from "./qr-code";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";
import { Button } from "@/components/ui/button";

interface Setup {
  totpURI: string;
  backupCodes: string[];
}

/**
 * Two-factor authentication (TOTP) for the signed-in user, on Settings.
 * Every control is a ghost: the page's one primary is Create key.
 */
export function TwoFactorPanel({ enabled }: { enabled: boolean }) {
  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">Two-factor authentication</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            A code from an authenticator app at sign-in. Connecting numbers, API keys and
            webhook settings require it.
          </FrameDescription>
        </FrameHeader>
        <div className="mt-5">
          {enabled ? (
            <>
              <span className={`block ${MACHINE_CLASS}`}>On</span>
              <p className="mt-1.5 mb-0 text-sm text-muted-foreground">
                Sign-ins to this account ask for a code from your authenticator app.
              </p>
            </>
          ) : (
            // A full load: enrolling re-issued the session, so the loaders re-run.
            <TwoFactorSetup onDone={() => window.location.assign("/settings")} />
          )}
        </div>
      </FramePanel>
    </Frame>
  );
}

/**
 * Enrollment: password, then the QR code and the first code, then the backup
 * codes. `onEnrolled` fires once the codes are on screen and cannot be shown
 * again; `onDone` when the operator has dealt with them.
 */
export function TwoFactorSetup({
  onEnrolled,
  onDone,
}: {
  onEnrolled?: () => void;
  onDone: () => void;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [verified, setVerified] = useState(false);
  if (!setup) return <StartStep onStarted={setSetup} />;
  if (!verified) {
    return (
      <VerifyStep
        totpURI={setup.totpURI}
        onVerified={() => {
          setVerified(true);
          onEnrolled?.();
        }}
      />
    );
  }
  return <BackupCodes codes={setup.backupCodes} onDone={onDone} />;
}

function StartStep({ onStarted }: { onStarted: (setup: Setup) => void }) {
  // Not fixed ids: the panel and the step-up sheet can be mounted together.
  const id = useId();
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
    <form onSubmit={onSubmit} aria-busy={busy} className="flex max-w-sm flex-col gap-3">
      <PasswordField
        id={`${id}-password`}
        label="Your password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        hasError={Boolean(error)}
        errorId={error ? `${id}-error` : undefined}
      />
      <div>
        <Button type="submit" variant="outline" disabled={busy || !password}>
          {busy ? "Starting…" : "Set up"}
        </Button>
      </div>
      {error ? (
        <output id={`${id}-error`} aria-live="polite" className={ERROR_CLASS}>
          {error}
        </output>
      ) : null}
    </form>
  );
}

/** Check the first code of an enrollment, which turns the factor on. */
async function verifyFirstCode(code: string): Promise<string | null> {
  const result = await authClient.twoFactor.verifyTotp({ code }).catch(() => null);
  if (!result) return "Could not verify the code right now. Please try again.";
  return result.error ? twoFactorErrorMessage(result.error.code) : null;
}

function VerifyStep({ totpURI, onVerified }: { totpURI: string; onVerified: () => void }) {
  return (
    <div className="flex flex-wrap items-start gap-5">
      <QrCode value={totpURI} label="QR code for your authenticator app" />
      <div className="flex min-w-0 max-w-sm flex-1 flex-col gap-3">
        <p className="m-0 text-sm text-pretty text-muted-foreground">
          Scan the code with an authenticator app, or enter this key by hand.
        </p>
        <code className="font-mono text-xs break-all text-foreground">{totpSecret(totpURI)}</code>
        <TwoFactorCodeForm enrolling verify={verifyFirstCode} onVerified={onVerified} />
      </div>
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

/** Shown once, after the first code verifies. Exported for direct rendering in tests. */
export function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copy, setCopy] = useState<CopyState>("idle");
  return (
    <div className="border border-(--line-strong) bg-(--ghost-fill) p-3">
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
          onClick={() => {
            // Absent outside a secure context, and it can refuse: both end in
            // the hint to copy by hand.
            const written = navigator.clipboard?.writeText(codes.join("\n"));
            if (!written) setCopy("failed");
            else void written.then(() => setCopy("copied"), () => setCopy("failed"));
          }}
        >
          {copy === "copied" ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
      <output aria-live="polite" className={copy === "failed" ? ERROR_CLASS : undefined}>
        {copy === "failed"
          ? "The browser refused to copy. Select the codes above and copy them by hand."
          : null}
      </output>
    </div>
  );
}
