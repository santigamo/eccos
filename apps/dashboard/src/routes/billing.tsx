import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { invalidatePage } from "../lib/invalidate";
import { Page } from "../ui";
import { confirmCheckout, getBillingPage, type BillingPage, type Result } from "../server/gateway";
import { FailureView } from "../components/dashboard/failure";
import { SectionsSkeleton } from "../components/dashboard/settings-section";
import { BillingView } from "../components/dashboard/billing-view";
import { checkoutReturnNote, needsSubscription } from "../components/dashboard/billing-panel";
import { CONFIG_STALE_MS } from "../lib/route-stale";
import { cn } from "@/lib/utils";

/** The workspace's subscription: every role reads it, owners and admins act on it. */
export const Route = createFileRoute("/billing")({
  staleTime: CONFIG_STALE_MS,
  // Creem returns the customer here with the subscription it created.
  validateSearch: (search: Record<string, unknown>): { billing?: "success"; subscription_id?: string } => ({
    billing: search.billing === "success" ? "success" : undefined,
    subscription_id: typeof search.subscription_id === "string" ? search.subscription_id : undefined,
  }),
  loader: () => getBillingPage(),
  component: BillingRoute,
  pendingComponent: () => (
    <Page title="Billing" kicker="Workspace">
      <SectionsSkeleton heights={["h-40", "h-28", "h-28"]} />
    </Page>
  ),
});

function BillingRoute() {
  const page = Route.useLoaderData();
  const router = useRouter();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [returned, setReturned] = useState(false);
  // The webhook may land after Creem's redirect, so the return asks Creem itself.
  // Once: the parameters then leave the URL, and a reload does not ask again.
  useEffect(() => {
    if (search.billing !== "success") return;
    let current = true;
    void (async () => {
      if (search.subscription_id) {
        await confirmCheckout({ data: { subscriptionId: search.subscription_id } }).catch(() => null);
      }
      if (!current) return;
      setReturned(true);
      await navigate({ search: {}, replace: true });
      await invalidatePage(router);
    })();
    return () => {
      current = false;
    };
  }, [search.billing, search.subscription_id, navigate, router]);
  return <BillingScreen page={page} returned={returned} now={Date.now()} />;
}

/** The page itself, free of router hooks (`tests/billing-page.test.tsx`). */
export function BillingScreen({ page, returned, now }: { page: Result<BillingPage | null>; returned?: boolean; now: number }) {
  return (
    <Page title="Billing" kicker="Workspace">
      {!page.ok ? (
        <FailureView failure={page} />
      ) : page.data === null ? (
        <p className="m-0 text-sm text-muted-foreground">Billing is not enabled on this console.</p>
      ) : (
        <>
          {returned ? (
            <output
              className={cn(
                "mb-6 block border-l-2 px-3 py-2 text-sm text-foreground",
                needsSubscription(page.data.billing) ? "border-l-warning" : "border-l-(--mark)",
              )}
            >
              {checkoutReturnNote(page.data.billing)}
            </output>
          ) : null}
          <BillingView page={page.data} now={now} />
        </>
      )}
    </Page>
  );
}
