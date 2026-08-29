import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../reui/frame";
import {
      startConnect,
      type DashboardState,
    } from "../../server/gateway";
import { Page } from "../../ui";

export function SetupScreen({ state }: { state: DashboardState }) {
  const router = useRouter();
  const existingAccount = state.stage === "account-ready" ? state.resources.account : null;

  return (
    <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto flex min-h-[calc(100svh-4rem)] max-w-5xl flex-col">
        <div className="flex items-center gap-2 border-b border-(--line) pb-4">
          <span className="font-pixel text-xs tracking-[0.04em] text-foreground uppercase">Eccos</span>
          <span className="text-muted-foreground text-xs">First-run setup</span>
        </div>
        <div className="flex flex-1 flex-col justify-center py-12">
          <SetupComplete
            result={{
              status: "existing" as const,
              account: existingAccount ?? { accountId: "", name: "", createdAt: 0 },
            }}
            onDone={() => void router.invalidate()}
          />
        </div>
      </div>
    </main>
  );
}

function SetupComplete({
  result,
  onDone,
}: {
  result: { status: "existing"; account: { accountId: string; name: string; createdAt: number } };
  onDone: () => void;
}) {
  const account = result.account;

  return (
    <Page title="Workspace ready" kicker="First run">
      <div className="grid max-w-4xl gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
        <Frame variant="default" spacing="lg">
          <FramePanel fit>
            <FrameHeader>
              <FrameTitle>{account?.name || "Eccos workspace"}</FrameTitle>
              <FrameDescription>
                This workspace is bound to its own account scope. No deployment variable is required
                for the account ID.
              </FrameDescription>
            </FrameHeader>
            <dl className="m-0 divide-y divide-(--frame-panel-border-color)">
              <SetupField label="Account ID" value={account?.accountId || "—"} />
              <SetupField label="Status" value="Ready for WhatsApp" />
            </dl>
          </FramePanel>
        </Frame>

        <div className="flex flex-col gap-4">
          <ConnectWhatsAppPanel onConnected={onDone} />
        </div>
      </div>
    </Page>
  );
}

function ApiKeyPanel({ apiKey }: { apiKey: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copyKey() {
    setCopyError(false);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }

  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader>
          <FrameTitle>Save your API key</FrameTitle>
          <FrameDescription>
            It is shown once. Store it in a password manager before leaving this page.
          </FrameDescription>
        </FrameHeader>
        <div className="flex flex-col gap-3">
          <code className="block overflow-x-auto border border-[rgba(240,160,32,.3)] bg-[rgba(240,160,32,.08)] p-3 text-xs text-foreground select-all">
            {apiKey}
          </code>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" onClick={copyKey}>
              {copied ? "Copied" : "Copy API key"}
            </Button>
            <span className="text-muted-foreground text-xs">
              {copyError ? "Copy failed — select the key manually." : "Raw keys are never stored by Eccos."}
            </span>
          </div>
        </div>
      </FramePanel>
    </Frame>
  );
}

function ConnectWhatsAppPanel({ onConnected }: { onConnected: () => void }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const result = await startConnect();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      window.location.assign(result.data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Frame variant="ghost" spacing="lg">
      <FramePanel fit>
        <FrameHeader>
          <FrameTitle>Connect WhatsApp</FrameTitle>
          <FrameDescription>
            Connect a WhatsApp Business account through Meta Embedded Signup to start receiving
            traffic. The handoff is bound to this protected workspace.
          </FrameDescription>
        </FrameHeader>
        <div className="flex flex-col items-start gap-3">
          <Button type="button" onClick={start} disabled={starting}>
            {starting ? "Opening Embedded Signup…" : "Connect WhatsApp"}
          </Button>
          <p className="m-0 text-sm text-muted-foreground">
            Meta will open in this tab. After setup finishes, return to this dashboard and refresh.
          </p>
          {error ? (
            <p className="m-0 border-l-2 border-[#e03131] bg-[rgba(224,49,49,.12)] px-3 py-2 text-sm text-[#ff7777]" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </FramePanel>
    </Frame>
  );
}

function SetupField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
      <dt className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="m-0 font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}
