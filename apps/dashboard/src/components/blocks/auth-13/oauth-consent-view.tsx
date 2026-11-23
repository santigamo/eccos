import { useEffect, useState } from "react";
import { authClient } from "@/auth/auth-client";
import { Logo } from "@/components/blocks/app-shell-7/components/logo";
import { AUTH_ERROR_BANNER_CLASS } from "@/components/auth/auth-page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { OFFLINE_ACCESS, requestedScopes } from "@/lib/oauth-scopes";
import { AuthSplitShell } from "./components/auth";

export const AUTHORIZATION_EXPIRED =
  "This request has expired or was already answered. Go back to your agent and connect again.";

/**
 * Asks Better Auth's `oauth2/continue` or `oauth2/consent` for the next step of
 * the authorization this page was opened for (`oauthProviderClient` adds the
 * page's signed query), and goes there. False when there is no next step.
 */
export async function followAuthorization(path: "/oauth2/continue" | "/oauth2/consent", body: object): Promise<boolean> {
  const result = await authClient.$fetch<{ url?: string }>(path, { method: "POST", body }).catch(() => null);
  const next = result?.data?.url;
  if (!next) return false;
  window.location.assign(next);
  return true;
}

const LABEL_CLASS = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";

/**
 * The consent page of an agent's authorization (design §3.2, §3.4): who is
 * asking, where the answer goes, which workspace it acts in, and each scope as
 * a choice the person can untick. The client's name is whatever its registrant
 * chose, so the host its answer is sent to sits next to it.
 */
export function OAuthConsentView({
  clientName,
  redirectHost,
  workspaceName,
  scope,
}: {
  clientName: string;
  redirectHost: string;
  workspaceName: string;
  scope: string;
}) {
  const { choices, offlineAccess } = requestedScopes(scope);
  const [ticked, setTicked] = useState(() => new Set(choices.map((choice) => choice.scope)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Connect an agent · Eccos";
  }, []);

  function toggle(scope: string, checked: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
  }

  async function decide(accept: boolean) {
    setPending(true);
    setError(null);
    const granted = choices.map((choice) => choice.scope).filter((scope) => ticked.has(scope));
    const body = accept ? { accept, scope: [...granted, ...(offlineAccess ? [OFFLINE_ACCESS] : [])].join(" ") } : { accept };
    if (await followAuthorization("/oauth2/consent", body)) return;
    setPending(false);
    setError(AUTHORIZATION_EXPIRED);
  }

  return (
    <AuthSplitShell>
      <div className="mx-auto flex w-full max-w-md flex-col gap-8">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="text-foreground text-sm font-semibold tracking-[0.18em] uppercase">Eccos</span>
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl leading-tight font-semibold text-balance">Connect an agent</h1>
            <p className="text-muted-foreground text-base text-pretty">
              An agent is asking to act as you in one workspace. It can never do more than your role there allows.
            </p>
          </div>
        </div>

        <dl className="flex flex-col border-y border-(--line)">
          <div className="flex items-baseline justify-between gap-4 border-b border-(--line) py-3">
            <dt className={LABEL_CLASS}>Agent</dt>
            <dd className="text-foreground text-sm font-medium wrap-anywhere text-right">{clientName}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-b border-(--line) py-3">
            <dt className={LABEL_CLASS}>Returns to</dt>
            <dd className="text-foreground font-mono text-sm wrap-anywhere text-right">{redirectHost}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-3">
            <dt className={LABEL_CLASS}>Workspace</dt>
            <dd className="text-foreground text-sm font-medium wrap-anywhere text-right">{workspaceName}</dd>
          </div>
        </dl>
        <p className="text-muted-foreground -mt-5 text-xs text-pretty">
          Whoever set up the agent chose its name. Allow it only if you recognise the address it returns to.
        </p>

        <div className="flex flex-col gap-4">
          <p className={LABEL_CLASS}>It may</p>
          {choices.map((choice) => (
            <Field key={choice.scope} orientation="horizontal" data-scope={choice.scope}>
              <Checkbox
                id={`consent-${choice.scope}`}
                checked={ticked.has(choice.scope)}
                onCheckedChange={(checked) => toggle(choice.scope, checked)}
                disabled={pending}
              />
              <FieldContent>
                <FieldLabel htmlFor={`consent-${choice.scope}`} className="text-sm font-medium text-foreground">
                  {choice.title}
                </FieldLabel>
                <FieldDescription className="text-sm">{choice.detail}</FieldDescription>
              </FieldContent>
            </Field>
          ))}
          {offlineAccess ? (
            <p className="text-muted-foreground text-sm text-pretty">
              It stays connected and renews its access without asking you again.
            </p>
          ) : null}
        </div>

        {error ? (
          <p className={AUTH_ERROR_BANNER_CLASS} role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <Button type="button" disabled={pending || ticked.size === 0} onClick={() => void decide(true)} className="w-full">
            Allow
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => void decide(false)} className="w-full">
            Deny
          </Button>
        </div>
      </div>
    </AuthSplitShell>
  );
}
