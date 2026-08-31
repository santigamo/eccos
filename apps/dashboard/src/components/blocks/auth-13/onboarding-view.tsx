import { useEffect, useState } from "react";
import { createOrganization } from "@/organizations";
import { AuthSplitShell } from "./components/auth";
import {
  WorkspaceForm,
  slugifyWorkspaceName,
} from "./components/workspace-form";

/**
 * First-run onboarding on the reui auth-13 split-screen skeleton: the same
 * brand shell as sign-in, but the form column creates the user's workspace
 * (organization + Eccos account via the idempotent provisioning saga). Only
 * reachable with zero organization memberships — the root loader redirects
 * anyone else past it.
 */
export function OnboardingView() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    document.title = "Create your workspace · Eccos";
  }, []);

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
    // Full navigation: the root loader re-runs with the fresh stage and lands
    // inside the app chrome on /numbers, whose empty state is the connect flow.
    window.location.assign("/numbers");
  }

  return (
    <AuthSplitShell>
      <WorkspaceForm
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
    </AuthSplitShell>
  );
}
