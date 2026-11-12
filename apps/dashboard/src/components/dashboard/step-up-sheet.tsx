import type { StepUpReason } from "@eccos/auth-baseline/step-up";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { invalidateRoutes, rootRouteId } from "../../lib/invalidate";
import { registerStepUpPrompt, settleStepUp } from "../../lib/step-up";
import { twoFactorErrorMessage } from "../../lib/two-factor";
import { confirmStepUpCode } from "../../server/step-up";
import { TwoFactorCodeForm } from "../auth/two-factor-code-form";
import { TwoFactorSetup } from "./two-factor";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const COPY: Record<StepUpReason, { title: string; description: string }> = {
  "totp-required": {
    title: "Set up two-factor authentication",
    description:
      "The action you started needs it. Set it up here and the action continues; the page behind stays as you left it.",
  },
  "reauth-required": {
    title: "Confirm it's you",
    description:
      "The action you started needs your two-factor code again. It continues once you confirm; the page behind stays as you left it.",
  },
};

/** Check a code against the current session; the message to show, or null when it passed. */
async function verifyOnSession(code: string, backup: boolean): Promise<string | null> {
  const result = await confirmStepUpCode({ data: { code, backup } }).catch(() => null);
  if (!result) return "Could not verify the code right now. Please try again.";
  if (result.ok) return null;
  if (result.code === "locked") return twoFactorErrorMessage("ACCOUNT_TEMPORARILY_LOCKED");
  if (result.code === "signed-out") return "This session is no longer signed in. Reload the page and sign in.";
  return twoFactorErrorMessage("INVALID_CODE");
}

/**
 * The step-up prompt (task register): the form a refused sensitive action
 * needs, beside the page it was started on. Mounted once in the shell; call
 * sites reach it through `withStepUp`.
 */
export function StepUpSheet() {
  const router = useRouter();
  const [reason, setReason] = useState<StepUpReason | null>(null);
  // Backup codes are on screen and cannot be shown again: only Done leaves.
  const [locked, setLocked] = useState(false);

  useEffect(
    () =>
      registerStepUpPrompt((next) => {
        setReason(next);
        setLocked(false);
      }),
    [],
  );

  function enrolled() {
    // The shell's own view of the user (enrolled or not) is now out of date.
    void invalidateRoutes(router, rootRouteId);
    settleStepUp(true);
  }

  const copy = reason ? COPY[reason] : null;
  return (
    <Sheet
      open={reason !== null}
      onOpenChange={(open) => {
        if (!open && !locked) settleStepUp(false);
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
          {reason === "totp-required" ? (
            <TwoFactorSetup onEnrolled={() => setLocked(true)} onDone={enrolled} />
          ) : reason ? (
            <TwoFactorCodeForm verify={verifyOnSession} onVerified={() => settleStepUp(true)} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
