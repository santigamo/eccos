import { createFileRoute } from "@tanstack/react-router";
import { Page } from "../ui";
import { TokenConnectPanel } from "../components/dashboard/connect-token";

/**
 * Attach a WABA from a pasted Meta token — an UNLISTED route (decided by Santi,
 * 2026-09-03).
 *
 * ── WHY IT IS NOT IN THE NAVIGATION ─────────────────────────────────────────
 * The panel below can only ever work for a token issued by THIS deployment's
 * own Meta app: `debug_token` cannot introspect anyone else's, so a customer
 * who finds this form gets an honest `foreign_app` refusal pointing at Embedded
 * Signup — and a form you can never use is still a form you had to be refused
 * by. One deployment serves every customer (`server.ts` hard-codes
 * `CANONICAL_HOSTS = {"app.eccos.chat"}`), so the surface exists for exactly one
 * operator and is advertised to everyone.
 *
 * Three alternatives were considered and rejected:
 *  - a per-organization `isOperator` flag — rejected by Santi;
 *  - a role gate — a customer org's OWNER also holds a foreign token, so role
 *    does not discriminate on the property that matters (which app issued the
 *    token); `Membership` (`auth/tenant.ts`) does not even carry the role
 *    client-side, so the console cannot hide anything by role today;
 *  - a deployment flag — it would either hide the form from the one operator it
 *    exists for, or show it to every customer anyway.
 *
 * ── WHY THIS IS STILL "HONEST INSTEAD OF HIDDEN" ────────────────────────────
 * That argument (see `components/dashboard/connect-token.tsx`) rejects making
 * the capability NOT EXIST for the operator it exists for. An unlisted route
 * exists for everyone who knows the URL — which is exactly the operator — and
 * anyone who arrives is told the precondition up front and refused by name.
 * Nothing pretends the capability is absent. What changed is that it is no
 * longer advertised to people it cannot serve.
 *
 * ── THE COST, ACCEPTED ──────────────────────────────────────────────────────
 * Renewing the Cloud API test token is a DAILY action while App Review
 * screencasts are being filmed, and it is now "go to the bookmark" instead of
 * "it is right there in Settings". Worse for the one operator, much better for
 * every customer. Do not "fix" this by adding a nav entry, a link from
 * /numbers, or a discovery affordance of any kind — that is the whole decision.
 *
 * `requires` is `"none"` in `lib/scope-requirements.ts` (and only there —
 * `NAV_MAIN` must not name it): attaching the test number is the way OUT of the
 * no-WABA state, so gating it on a WABA would lock the form that creates one.
 */
export const Route = createFileRoute("/numbers_/attach-token")({
  component: AttachTokenPage,
});

/**
 * A real header band, like every other route. Someone arriving here came from a
 * bookmark or a typed URL — there is no breadcrumb behind them — so the page
 * has to say where they are before it shows them a credential field.
 */
export function AttachTokenPage() {
  return (
    <Page title="Attach by token" kicker="Connection">
      <div className="flex max-w-xl flex-col gap-4">
        <TokenConnectPanel />
      </div>
    </Page>
  );
}
