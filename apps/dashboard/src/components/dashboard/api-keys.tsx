import { useState, type FormEvent } from "react";
import {
  issueApiKey,
  revokeApiKey,
  type AccountKeyResource,
  type IssuedApiKey,
  type Result,
} from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { fmtTsShort } from "../../ui";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The hosted gateway's public origin, the one `api.eccos.chat` route. */
export const GATEWAY_ORIGIN = "https://api.eccos.chat";

const MACHINE_CLASS = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
const ERROR_CLASS =
  "bg-destructive/10 text-destructive-foreground mt-3 block border border-destructive/20 p-3 text-xs";

/**
 * Account API keys: create, list, revoke (eccos-bm92).
 *
 * Router-free like the forwarding-target panel: the route owns the list and
 * re-reads it through `onChanged`. Every action is `administer` on the server;
 * a role without it gets the refusal copy here instead of the controls.
 */
export function ApiKeysPanel({
  keys,
  wabaId,
  onChanged,
}: {
  keys: Result<AccountKeyResource[]>;
  wabaId?: string;
  onChanged?: () => void;
}) {
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AccountKeyResource | null>(null);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await issueApiKey({ data: { label } });
      if (!res.ok) {
        setError(failureCopy(res).detail);
        return;
      }
      setIssued(res.data);
      setLabel("");
      onChanged?.();
    } finally {
      setCreating(false);
    }
  }

  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">API keys</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            Keys let your server send messages and export data through the
            Eccos API on behalf of this workspace.
          </FrameDescription>
        </FrameHeader>

        {keys.ok ? (
          <>
            {issued ? <IssuedKeyNotice issued={issued} onDone={() => setIssued(null)} /> : null}

            <form onSubmit={onCreate} aria-busy={creating} className="mt-5 flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor="api-key-label" className={`mb-1 block ${MACHINE_CLASS}`}>
                  Label
                </label>
                <Input
                  id="api-key-label"
                  value={label}
                  maxLength={200}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. production server"
                />
              </div>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create key"}
              </Button>
            </form>
            {error ? (
              <output aria-live="polite" className={ERROR_CLASS}>
                {error}
              </output>
            ) : null}

            <KeyList keys={keys.data} onRevoke={setRevoking} />
            <SendSnippet wabaId={wabaId} />
          </>
        ) : (
          <KeysUnavailable keys={keys} />
        )}

        {revoking ? (
          <RevokeKeyDialog
            target={revoking}
            onOpenChange={(open) => {
              if (!open) setRevoking(null);
            }}
            onRevoked={onChanged}
          />
        ) : null}
      </FramePanel>
    </Frame>
  );
}

function KeysUnavailable({ keys }: { keys: Extract<Result<AccountKeyResource[]>, { ok: false }> }) {
  const copy = failureCopy(keys);
  return (
    <div className="mt-5">
      <span className={`block ${MACHINE_CLASS}`}>{copy.title}</span>
      <p className="mt-1.5 mb-0 text-sm text-muted-foreground">{copy.detail}</p>
    </div>
  );
}

/** The raw key, shown once. Exported so it can be rendered directly in tests. */
export function IssuedKeyNotice({
  issued,
  onDone,
}: {
  issued: IssuedApiKey;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-5 border border-(--line-strong) bg-(--ghost-fill) p-3">
      <span className={`block ${MACHINE_CLASS}`}>New key</span>
      <code className="mt-2 block font-mono text-xs break-all text-foreground">{issued.apiKey}</code>
      <p className="mt-2 mb-0 text-xs text-[#f0a020]">
        Copy it now. You won't see this key again: Eccos stores only its hash.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(issued.apiKey).then(() => setCopied(true))
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function KeyList({
  keys,
  onRevoke,
}: {
  keys: AccountKeyResource[];
  onRevoke: (key: AccountKeyResource) => void;
}) {
  if (keys.length === 0) {
    return (
      <div className="mt-5">
        <span className={`block ${MACHINE_CLASS}`}>No keys yet</span>
        <p className="mt-1.5 mb-0 text-sm text-muted-foreground">
          Keys you create appear here. Until one exists, this workspace can
          receive events but not send.
        </p>
      </div>
    );
  }
  const sorted = [...keys].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <ul className="my-0 -mx-(--frame-panel-px) mt-5 list-none divide-y divide-(--line) border-y border-(--line) p-0">
      {sorted.map((key) => (
        <li
          key={key.keyId}
          className="flex items-center justify-between gap-4 px-(--frame-panel-px) py-2.5"
        >
          <div className="min-w-0">
            <span className="block truncate text-sm text-foreground">{key.label ?? "Unlabelled"}</span>
            <span className="block font-mono text-xs text-muted-foreground">
              <span className="break-all">{key.keyId}</span> ·{" "}
              <span className="whitespace-nowrap">created {fmtTsShort(key.createdAt)}</span>
            </span>
          </div>
          {key.revokedAt === null ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onRevoke(key)}>
              Revoke
            </Button>
          ) : (
            <span className={`shrink-0 ${MACHINE_CLASS}`}>Revoked {fmtTsShort(key.revokedAt)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function RevokeKeyDialog({
  target,
  onOpenChange,
  onRevoked,
}: {
  target: AccountKeyResource;
  onOpenChange: (open: boolean) => void;
  onRevoked?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await revokeApiKey({ data: { keyId: target.keyId } });
      if (!res.ok) {
        setError(failureCopy(res).detail);
        return;
      }
      if (!res.data) {
        setError("This key is already revoked. Reload the page to see its state.");
        return;
      }
      onRevoked?.();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this key?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block font-mono text-[11px] break-all text-foreground">
              {target.label ?? "Unlabelled"} · {target.keyId}
            </span>
            <span className="mt-1 block">
              Requests using it are refused from now on. This cannot be undone.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <output aria-live="polite" aria-atomic="true">
          {error ? <span className="block text-xs text-[#ff7777]">{error}</span> : null}
        </output>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction type="button" onClick={onConfirm} aria-busy={busy} disabled={busy}>
            {busy ? "Revoking…" : "Revoke key"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** How a key is used: the send endpoint, with this workspace's WABA when known. */
export function SendSnippet({ wabaId }: { wabaId?: string }) {
  const snippet = `curl -X POST ${GATEWAY_ORIGIN}/v1/wabas/${wabaId ?? "<WABA_ID>"}/messages \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "<PHONE>", "type": "text", "text": {"body": "Hello"}}'`;
  return (
    <div className="mt-5">
      <span className={`block ${MACHINE_CLASS}`}>Send a message</span>
      <pre className="mt-2 mb-0 overflow-x-auto border border-(--line) p-3 font-mono text-xs text-foreground">
        {snippet}
      </pre>
    </div>
  );
}
