import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { billableCount } from "../billing/account";
import { FailureView } from "../components/dashboard/failure";
import { blocksSends } from "@eccos/gateway-contract/billing-status";
import { SetupPaused } from "../components/setup-paths/setup-paused";
import { SetupWizard } from "../components/setup-paths/setup-wizard";
import { pendingActivation } from "../lib/activation";
import { getGatewayOrigin } from "../server/gateway";
import { Page } from "../ui";

/**
 * Steps 5 and 6 of first run, after the connect wizard: pick a goal, set it up,
 * prove it live, then the paywall. The root bounces here to /numbers until a
 * number is active (`lib/scope-requirements.ts`, default "number").
 */
export const Route = createFileRoute("/setup")({
  loader: () => getGatewayOrigin(),
  component: SetupPage,
});

function SetupPage() {
  const root = useLoaderData({ from: "__root__" });
  const origin = Route.useLoaderData();
  const navigate = Route.useNavigate();
  if (!root.ok || root.data.stage !== "ready") {
    return (
      <Page title="Set up WhatsApp" kicker="First run">
        {root.ok ? null : <FailureView failure={root} />}
      </Page>
    );
  }
  const { scope } = root.data;
  const waba = scope.resources.wabas.find((w) => w.wabaId === scope.selectedWabaId);
  const phone = waba?.phones[0];
  return (
    <Page title="Set up WhatsApp" kicker="First run">
      <div className="flex flex-1 items-center justify-center pb-[10vh]">
        {scope.resources.account && blocksSends(scope.resources.account.billingStatus) ? (
          <SetupPaused />
        ) : phone ? (
          <SetupWizard
            wabaId={scope.selectedWabaId}
            phoneNumberId={phone.phoneNumberId}
            phone={phone.displayPhoneNumber}
            gatewayOrigin={origin.ok ? origin.data : null}
            numbers={billableCount(scope.resources.wabas)}
            canManage={root.data.billing?.canManage === true}
            offer={root.data.billing !== undefined && scope.resources.account?.billingStatus === "setup"}
            activation={pendingActivation(root.data)}
            navigate={(to) => void navigate({ to })}
          />
        ) : null}
      </div>
    </Page>
  );
}
