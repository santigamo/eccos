import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { createOrganization } from "../organizations";
import { Page } from "../ui";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";
import {
  WorkspaceFormFields,
  slugifyWorkspaceName,
} from "../components/blocks/auth-13/components/workspace-form";

/**
 * Creating an ADDITIONAL workspace, from inside the console.
 *
 * WHY THIS IS NOT `/onboarding`. `createOrganization` has always worked; its
 * only caller was the first-run onboarding screen, and the root loader
 * redirects `/onboarding` → `/` as soon as the account has a workspace. That
 * redirect is not a bug — it is what stops a half-onboarded session from
 * landing back on a step it already completed — so it stays exactly as it is.
 * What was missing is that "you have no workspace, go make one" and "you have
 * one and want another" are two different situations and were sharing one
 * route:
 *
 * - `/onboarding` is the FIRST RUN. There is no tenant yet, so there is no app
 *   chrome to render around it; it lives on the brand split-screen, it is the
 *   only place the account can go, and it must be unreachable afterwards.
 * - `/workspaces/new` is a DELIBERATE ACT from inside a working console. It has
 *   the shell around it — sidebar, current workspace, a way back — and it
 *   requires an existing membership; an account with none is redirected to
 *   `/onboarding` by the root loader before this component ever renders.
 *
 * Same server function, same provisioning saga, two entry points that mean
 * different things.
 */
export const Route = createFileRoute("/workspaces/new")({
  component: NewWorkspacePage,
});

function NewWorkspacePage() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const effectiveSlug = slugTouched ? slug : slugifyWorkspaceName(name);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    let result: Awaited<ReturnType<typeof createOrganization>>;
    try {
      result = await createOrganization({
        data: { name: name.trim(), slug: effectiveSlug },
      });
    } catch {
      // Thrown client failure (network, non-JSON 5xx): reset pending and show
      // a generic error instead of a stuck button.
      setPending(false);
      setError("Could not create the workspace right now. Please try again.");
      return;
    }
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Better Auth makes a newly created organization the session's active one,
    // so the console is already scoped to the new workspace. A full navigation
    // (not a router push) is what re-runs the whole loader tree in that scope —
    // the same thing the switcher's reload does. It lands on /numbers, whose
    // empty state is the connect flow, because a fresh workspace has no WABA.
    window.location.assign("/numbers");
  }

  return (
    <Page title="New workspace" kicker="Workspaces">
      <div className="flex max-w-xl flex-col gap-4">
        <Frame variant="default" spacing="lg">
          <FramePanel fit>
            <FrameHeader className="gap-1.5 pt-0">
              <FrameTitle className="text-sm font-semibold">
                Create another workspace
              </FrameTitle>
              <FrameDescription className="max-w-prose text-pretty">
                A workspace is a separate Eccos account with its own numbers,
                keys, and logs — nothing is shared with the one you are in now.
                You will be switched into the new workspace once it is created.
              </FrameDescription>
            </FrameHeader>
            <div className="pt-5">
              <WorkspaceFormFields
                idPrefix="new-workspace"
                name={name}
                onNameChange={setName}
                slug={effectiveSlug}
                onSlugChange={(value) => {
                  setSlugTouched(true);
                  setSlug(value);
                }}
                error={error}
                pending={pending}
                onSubmit={onSubmit}
              />
            </div>
          </FramePanel>
        </Frame>
      </div>
    </Page>
  );
}
