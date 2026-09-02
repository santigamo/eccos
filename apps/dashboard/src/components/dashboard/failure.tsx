import type { Failure, Membership } from "../../server/gateway";
import { useWorkspaceSwitch } from "../../hooks/use-workspace-switch";
import { failureCopy } from "../../lib/failure";
import { workspaceLabel } from "../../lib/workspaces";
import { Unreachable } from "../../ui";
import { Button, buttonVariants } from "../ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../reui/frame";
import { cn } from "@/lib/utils";

/**
 * What a page renders in place of its content when a server function answered
 * `{ ok: false }` (eccos-k5a).
 *
 * The branch is on `failure.kind` — the class the server boundary read off the
 * thrown error's TYPE — so an authorization refusal is never dressed up as a
 * dead service binding. Only the transport case keeps the "Gateway unreachable"
 * card, because only there has the console established that the gateway is the
 * problem.
 *
 * Authorization states get no red banner: per docs/DASHBOARD-DESIGN.md colour
 * is spent on things that are wrong, and belonging to no workspace — or to
 * several — is a step the operator has not taken yet, not an outage. They read
 * like the console's other structured states (the pending note on /numbers):
 * what happened, one sentence, and an action only where one exists.
 */
export function FailureView({ failure }: { failure: Failure }) {
  if (failure.kind === "unreachable") {
    return <Unreachable error={failure.error} />;
  }
  const { title, detail } = failureCopy(failure);
  return (
    <Frame variant="default" spacing="lg" className="max-w-2xl">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">{title}</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">{detail}</FrameDescription>
        </FrameHeader>
        <FailureAction failure={failure} />
      </FramePanel>
    </Frame>
  );
}

/**
 * The way out, when there is one. No dead buttons on the states without one.
 *
 * Plain anchors, as elsewhere in the console for these targets: /signin and
 * /onboarding render outside the app shell, and which chrome a page gets is
 * decided by the root loader on a document load.
 */
function FailureAction({ failure }: { failure: Failure }) {
  if (failure.kind === "unauthenticated") {
    return (
      <div className="pt-5">
        <a href="/signin" className={cn(buttonVariants({ variant: "outline" }))}>
          Sign in
        </a>
      </div>
    );
  }
  if (failure.kind !== "forbidden") return null;
  if (failure.reason === "no-organization") {
    return (
      <div className="pt-5">
        <a href="/onboarding" className={cn(buttonVariants())}>
          Create a workspace
        </a>
      </div>
    );
  }
  if (failure.reason === "select-organization") {
    const organizations = failure.organizations ?? [];
    // No list resolved (the identity plane refused it too): the sentence stands
    // on its own rather than offering an empty picker.
    if (organizations.length === 0) return null;
    return <WorkspacePicker organizations={organizations} />;
  }
  return null;
}

/**
 * The choice itself, as rows on the console's shared grid rather than a control
 * that has to be discovered. Selecting one stores it as the session's active
 * organization — UX state; the server re-derives and re-validates the tenant on
 * every request regardless — then reloads so every loader runs in the new scope.
 *
 * This screen is now the FALLBACK, not the only way in: the masthead's
 * workspace crumb (masthead-breadcrumb.tsx) offers the same choice at any time
 * and shares the selection path through `useWorkspaceSwitch`. It still renders
 * here because a
 * user who has never chosen has no shell around them yet — the refused request
 * is what they are looking at.
 */
function WorkspacePicker({ organizations }: { organizations: Membership[] }) {
  const { pendingId: pending, error, choose } = useWorkspaceSwitch();

  return (
    <div className="pt-5">
      <ul
        aria-label="Your workspaces"
        className="m-0 -mx-(--frame-panel-px) list-none divide-y divide-(--line) border-y border-(--line) p-0"
      >
        {organizations.map((org) => (
          <li key={org.id}>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start rounded-none px-(--frame-panel-px) py-3 text-left"
              disabled={pending !== null}
              aria-busy={pending === org.id}
              onClick={() => choose(org.id)}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm text-foreground">
                  {workspaceLabel(org)}
                </span>
                {org.slug ? (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {org.slug}
                  </span>
                ) : null}
              </span>
            </Button>
          </li>
        ))}
      </ul>
      {/* Mounted even when empty: a live region that appears with its message is
          not reliably announced, one that fills up is. */}
      <output
        aria-live="polite"
        aria-atomic="true"
        className={
          error
            ? "mt-4 block border-l-2 border-l-[#e03131] px-3 py-2 text-sm break-words whitespace-pre-wrap text-foreground"
            : undefined
        }
      >
        {error}
      </output>
    </div>
  );
}
