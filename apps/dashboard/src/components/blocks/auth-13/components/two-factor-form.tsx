import { TwoFactorCodeForm } from "@/components/auth/two-factor-code-form";
import { Logo } from "@/components/blocks/app-shell-7/components/logo";

/**
 * The second step of sign-in for an account with two-factor authentication.
 * `restartHref` is the sign-in page with its redirect, so starting again still
 * ends where the operator was going.
 */
export function TwoFactorForm({
  onVerified,
  restartHref,
}: {
  onVerified: () => void;
  restartHref: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="text-foreground text-sm font-semibold tracking-[0.18em] uppercase">
            Eccos
          </span>
        </div>
        <h1 className="text-3xl leading-tight font-semibold text-balance">Two-factor code</h1>
      </div>

      <TwoFactorCodeForm onVerified={onVerified} />

      <a href={restartHref} className="text-muted-foreground text-xs hover:text-foreground">
        Start again
      </a>
    </div>
  );
}
