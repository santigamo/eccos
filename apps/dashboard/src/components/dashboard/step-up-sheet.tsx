import type { StepUpReason } from "@eccos/auth-baseline/step-up";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type RefObject } from "react";
import { invalidateRoutes, rootRouteId } from "../../lib/invalidate";
import { registerStepUpPrompt, settleStepUp, STEP_UP_COPY } from "../../lib/step-up";
import { lockedMessage, twoFactorErrorMessage, VERIFY_UNAVAILABLE } from "../../lib/two-factor";
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

/** Check a code against the current session; the message to show, or null when it passed. */
async function verifyOnSession(code: string, backup: boolean): Promise<string | null> {
  const result = await confirmStepUpCode({ data: { code, backup } }).catch(() => null);
  if (!result) return VERIFY_UNAVAILABLE;
  if (result.ok) return null;
  switch (result.code) {
    case "unavailable":
      return VERIFY_UNAVAILABLE;
    case "locked":
      return lockedMessage(result.minutes);
    case "signed-out":
      return "This session is no longer signed in. Reload the page and sign in.";
    case "used":
      return "That code was already used. Wait for your authenticator to show a new one.";
    case "not-enrolled":
      return "Two-factor authentication is not set up on this account yet. Finish it under Settings.";
    default:
      return twoFactorErrorMessage("INVALID_CODE");
  }
}

/**
 * The step-up prompt (task register): the form a refused sensitive action
 * needs, beside the page it was started on. Mounted once in the shell, and
 * again INSIDE any dialog that hosts a sensitive action, so there it opens as
 * that dialog's nested surface instead of a second modal beside it. Call sites
 * reach the innermost one through `withStepUp`.
 */
export function StepUpSheet({
  finalFocus,
}: {
  /** Where focus goes when the sheet closes, for a host whose trigger may be gone by then. */
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [reason, setReason] = useState<StepUpReason | null>(null);
  // Enrolling here also stepped the session up. From then on the action that
  // asked is confirmed, however the sheet comes to close.
  const enrolled = useRef(false);

  useEffect(
    () =>
      registerStepUpPrompt((next) => {
        enrolled.current = false;
        setReason(next);
      }),
    [],
  );

  function settle(ok: boolean) {
    // What the shell and the Numbers page know of the user (enrolled,
    // stepped up) is now out of date.
    if (ok) void invalidateRoutes(router, rootRouteId, "/numbers");
    settleStepUp(ok);
  }

  const copy = reason ? STEP_UP_COPY[reason] : null;
  return (
    <Sheet
      open={reason !== null}
      onOpenChange={(open) => {
        if (!open) settle(enrolled.current);
      }}
    >
      <SheetContent
        side="right"
        finalFocus={finalFocus}
        className="gap-2 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
      >
        <SheetHeader className="gap-2">
          <SheetTitle>{copy?.title}</SheetTitle>
          <SheetDescription>{copy?.prompt}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {reason === "totp-required" ? (
            <TwoFactorSetup
              onEnrolled={() => {
                enrolled.current = true;
              }}
              onDone={() => settle(true)}
            />
          ) : reason ? (
            <TwoFactorCodeForm verify={verifyOnSession} onVerified={() => settle(true)} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
