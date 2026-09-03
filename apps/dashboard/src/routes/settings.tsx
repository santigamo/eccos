import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { Page } from "../ui";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";

/**
 * Settings — the workspace's own identifiers, and nothing else.
 *
 * It used to carry the forwarding target, the re-subscribe handshake and the
 * pasted-token panel. All three left, and each for its own reason: the first
 * two are what "webhooks" means and now live on /webhooks with the callback URL
 * they belong beside; the token panel moved to an unlisted route
 * (`numbers_.attach-token.tsx`) so the customers it can never serve stop
 * meeting it.
 *
 * The page keeps `requires: "none"` — but on the Workspace panel's own merits
 * now, not the token panel's: the account id is an account-level fact and does
 * not wait on a number.
 */
export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const scope = useLoaderData({ from: "__root__" });
  // Both post-organization stages carry the account, in two shapes. Reachable
  // before any WABA exists, which is exactly why nothing here may need one.
  const ready = scope.ok && scope.data.stage === "ready" ? scope.data.scope : null;
  const pending =
    scope.ok && scope.data.stage === "account-ready" ? scope.data.resources : null;
  const accountId = ready?.accountId ?? pending?.account?.accountId;
  return <SettingsView accountId={accountId} />;
}

/**
 * The page itself, free of router hooks so it can be rendered directly
 * (`tests/settings-screen.test.tsx`).
 */
export function SettingsView({ accountId }: { accountId?: string }) {
  return (
    <Page title="Settings" kicker="Configuration">
      {/* A readable measure: full-bleed rows on a wide viewport read as a
          broken layout, not as a panel. */}
      <div className="flex max-w-xl flex-col gap-4">
        {accountId ? <WorkspacePanel accountId={accountId} /> : null}
      </div>
    </Page>
  );
}

/** Identifiers an operator needs when they open a support thread or an API key. */
function WorkspacePanel({ accountId }: { accountId: string }) {
  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">Workspace</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            The account scope every WABA, key, and log line in this console
            belongs to. Quote it in support threads.
          </FrameDescription>
        </FrameHeader>
        <dl className="my-0 -mx-(--frame-panel-px) mt-5 divide-y divide-(--line) border-y border-(--line)">
          <div className="flex items-center justify-between gap-4 px-(--frame-panel-px) py-2.5">
            <dt className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              Account ID
            </dt>
            <dd className="m-0 font-mono text-xs break-all text-foreground">{accountId}</dd>
          </div>
        </dl>
      </FramePanel>
    </Frame>
  );
}
