import { useEffect, useState } from "react";
import { useLoaderData, useLocation } from "@tanstack/react-router";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { billableCount } from "../../billing/account";
import { markPaywallSeen, paywallSeen, pendingActivation } from "../../lib/activation";
import type { DashboardState } from "../../server/gateway";
import { ActivationPaywall, PAYWALL_TITLE } from "./activation-paywall";
import { useLatestExchange } from "./use-latest-exchange";

function scopeOf(state: DashboardState) {
  if (state.stage === "ready") return { wabaId: state.scope.selectedWabaId, resources: state.scope.resources };
  if (state.stage === "account-ready") return { wabaId: state.resources.wabas[0]?.wabaId, resources: state.resources };
  return null;
}

/**
 * 2.3: activation the server saw while the operator was elsewhere in the
 * console. Asked once per viewer; /setup shows the same paywall in place.
 */
export function ActivationDialog() {
  const root = useLoaderData({ from: "__root__" });
  const pathname = useLocation({ select: (l) => l.pathname });
  // Storage is read after paint: the console server-renders.
  const [seen, setSeen] = useState(true);
  useEffect(() => setSeen(paywallSeen()), []);

  const state = root.ok ? root.data : null;
  const activation = state ? pendingActivation(state) : null;
  const open = activation !== null && !seen && pathname !== "/setup";
  const scope = state ? scopeOf(state) : null;
  const proof = useLatestExchange(scope?.wabaId, open);
  if (!open || !state || !scope) return null;

  function close() {
    markPaywallSeen();
    setSeen(true);
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="gap-0 border-(--line-strong) bg-muted p-7 sm:max-w-180">
        <ActivationPaywall
          proof={proof}
          numbers={billableCount(scope.resources.wabas)}
          canManage={"billing" in state && state.billing?.canManage === true}
          activation={activation}
          heading={
            <DialogTitle className="text-lg leading-6 font-semibold tracking-[-0.01em] text-foreground">{PAYWALL_TITLE}</DialogTitle>
          }
          onContinue={close}
        />
      </DialogContent>
    </Dialog>
  );
}
