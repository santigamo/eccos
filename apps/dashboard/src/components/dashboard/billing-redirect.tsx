import { isRedirect } from "@tanstack/react-router";
import { useState } from "react";
import type { Result } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";

/** Leaves for Creem (a checkout or the portal), or says why it could not. */
export function useBillingRedirect() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leaveTo(target: () => Promise<Result<{ url: string }>>) {
    setBusy(true);
    setError(null);
    try {
      const res = await target();
      if (res.ok) {
        window.location.assign(res.data.url);
        return;
      }
      setError(res.kind === "unreachable" ? "Billing could not be opened. Try again." : failureCopy(res).detail);
    } catch (thrown) {
      if (isRedirect(thrown)) throw thrown;
      setError("Billing could not be opened. Try again.");
    }
    setBusy(false);
  }

  return { busy, error, leaveTo };
}

export function BillingError({ error }: { error: string | null }) {
  return error ? (
    <output
      aria-live="polite"
      className="bg-destructive/10 text-destructive-foreground mt-3 block border border-destructive/20 p-3 text-xs"
    >
      {error}
    </output>
  ) : null;
}
