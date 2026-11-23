import { useEffect, useState } from "react";
import { createOrganization, selectOrganization } from "@/organizations";
import type { Membership } from "@/auth/tenant";
import { Logo } from "@/components/blocks/app-shell-7/components/logo";
import { AUTH_ERROR_BANNER_CLASS } from "@/components/auth/auth-page";
import { Button } from "@/components/ui/button";
import { followSignIn } from "@/lib/follow-sign-in";
import { AuthSplitShell } from "./components/auth";
import { WorkspaceForm } from "./components/workspace-form";
import { AUTHORIZATION_EXPIRED, followAuthorization } from "./oauth-consent-view";

const PICK_RETRY = "Could not choose that workspace right now. Please try again.";

/**
 * The workspace step of an agent's authorization (design §3.1, §3.5): a grant
 * acts in one workspace, so the person picks it, or names their first one with
 * the same form and provisioning as /onboarding. Either way the session's
 * active workspace is set server-side, only for a membership, and the
 * authorization continues to consent, which binds that workspace.
 */
export function OAuthWorkspaceView({ workspaces }: { workspaces: Membership[] }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Choose a workspace · Eccos";
  }, []);

  async function proceed(choose: () => Promise<{ ok: true } | { ok: false; error: string }>, key: string, failure: (error: string) => string) {
    setPending(key);
    setError(null);
    let chosen: { ok: true } | { ok: false; error: string };
    try {
      chosen = await choose();
    } catch (err) {
      if (followSignIn(err)) return;
      chosen = { ok: false, error: PICK_RETRY };
    }
    if (chosen.ok && (await followAuthorization("/oauth2/continue", { postLogin: true }))) return;
    setPending(null);
    setError(chosen.ok ? AUTHORIZATION_EXPIRED : failure(chosen.error));
  }

  if (workspaces.length === 0) {
    return (
      <AuthSplitShell>
        <WorkspaceForm
          name={name}
          onNameChange={setName}
          error={error}
          pending={pending !== null}
          onSubmit={(event) => {
            event.preventDefault();
            void proceed(
              async () => {
                const created = await createOrganization({ data: { name: name.trim() } });
                return created.ok ? { ok: true } : created;
              },
              "create",
              (message) => message,
            );
          }}
        />
      </AuthSplitShell>
    );
  }

  return (
    <AuthSplitShell>
      <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-8">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="text-foreground text-sm font-semibold tracking-[0.18em] uppercase">Eccos</span>
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl leading-tight font-semibold text-balance">Choose a workspace</h1>
            <p className="text-muted-foreground text-base text-pretty">
              The agent will work only in the workspace you choose. To use another one, connect it again.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Your workspaces</p>
          {workspaces.map((workspace) => (
            <Button
              key={workspace.id}
              type="button"
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                void proceed(() => selectOrganization({ data: { organizationId: workspace.id } }), workspace.id, () => PICK_RETRY)
              }
              className="w-full justify-start"
            >
              {workspace.name}
            </Button>
          ))}
        </div>
        {error ? (
          <p className={AUTH_ERROR_BANNER_CLASS} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </AuthSplitShell>
  );
}
