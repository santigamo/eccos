import { useState, type FormEvent } from "react";
import {
  issueApiKey,
  revokeApiKey,
  type AccountKeyResource,
  type IssuedApiKey,
  type Result,
} from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { withStepUp } from "../../lib/step-up";
import { StepUpSheet } from "./step-up-sheet";
import { INLINE_LINK, fmtTs, fmtTsShort } from "../../ui";
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
import { CopyButton } from "./copy-button";
import { SectionFrame, SettingsSection } from "./settings-section";
import { ERROR_CLASS, IDENTITY_TIER, MACHINE_CLASS, SECONDARY_TIER, SUPPORT_TIER } from "./plain-table";

/**
 * Account API keys: create, list, revoke (eccos-bm92).
 *
 * Router-free: the route owns the list and re-reads it through `onChanged`.
 * Every action is `administer` on the server; the route renders this only for
 * a role that holds it.
 */
export function ApiKeysPanel({
  keys,
  wabaId,
  gatewayOrigin,
  onChanged,
}: {
  keys: Result<AccountKeyResource[]>;
  wabaId?: string;
  gatewayOrigin?: string | null;
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
      const res = await withStepUp(() => issueApiKey({ data: { label } }));
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
    <>
      <SettingsSection
        id="keys"
        title="Keys"
        description="Keys let your server send messages and export data through the Eccos API on behalf of this workspace."
      >
        {keys.ok ? (
          <SectionFrame flush>
            <div className="flex flex-col gap-4 px-5 py-4">
              {issued ? <IssuedKeyNotice issued={issued} onDone={() => setIssued(null)} /> : null}
              <form onSubmit={onCreate} aria-busy={creating} className="flex flex-wrap items-end gap-2">
                <div className="w-full max-w-sm">
                  <label htmlFor="api-key-label" className={`mb-1.5 block ${MACHINE_CLASS}`}>
                    Label
                  </label>
                  <Input
                    id="api-key-label"
                    value={label}
                    maxLength={200}
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
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
            </div>
            <KeyTable keys={keys.data} onRevoke={setRevoking} />
          </SectionFrame>
        ) : (
          <SectionFrame>
            <KeysUnavailable keys={keys} />
          </SectionFrame>
        )}
      </SettingsSection>

      {keys.ok ? (
        <SettingsSection
          id="send"
          title="Send a message"
          description="Your server sends with a key in the Authorization header. The example uses this workspace's WhatsApp account, and a new key once you create one."
        >
          <SectionFrame>
            <SendSnippet wabaId={wabaId} gatewayOrigin={gatewayOrigin} apiKey={issued?.apiKey} />
          </SectionFrame>
        </SettingsSection>
      ) : null}

      {revoking ? (
        <RevokeKeyDialog
          target={revoking}
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
          onRevoked={onChanged}
        />
      ) : null}
    </>
  );
}

function KeysUnavailable({ keys }: { keys: Extract<Result<AccountKeyResource[]>, { ok: false }> }) {
  const copy = failureCopy(keys);
  return (
    <div>
      <span className={`block ${MACHINE_CLASS}`}>{copy.title}</span>
      <p className="mt-1.5 mb-0 text-sm text-muted-foreground">{copy.detail}</p>
    </div>
  );
}

/** The raw key, shown once. Exported so it can be rendered directly in tests. */
export function IssuedKeyNotice({ issued, onDone }: { issued: IssuedApiKey; onDone: () => void }) {
  return (
    <div className="border border-(--line-strong) bg-(--ghost-fill) p-3">
      <span className={`block ${MACHINE_CLASS}`}>New key</span>
      <code className="mt-2 block font-mono text-xs break-all text-foreground">{issued.apiKey}</code>
      <p className="mt-2 mb-0 text-xs text-warning-foreground">
        Copy it now. You won't see this key again: Eccos stores only its hash. The send example below carries it
        until you press Done.
      </p>
      <div className="mt-3 flex gap-2">
        <CopyButton value={issued.apiKey} variant="outline" size="sm" />
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

const HEAD_CELL = `px-5 py-2 text-left align-middle ${MACHINE_CLASS}`;

/** The keys, newest first: the label is the row's identity, the key id its machine name. */
export function KeyTable({
  keys,
  onRevoke,
}: {
  keys: AccountKeyResource[];
  onRevoke: (key: AccountKeyResource) => void;
}) {
  if (keys.length === 0) {
    return (
      <div className="border-t border-(--line) px-5 py-4">
        <span className={`block ${MACHINE_CLASS}`}>No keys yet</span>
        <p className="mt-1.5 mb-0 text-sm text-muted-foreground">
          Keys you create appear here. Your server needs one to send through
          the API; Conversations in this console works without it.
        </p>
      </div>
    );
  }
  const sorted = [...keys].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-(--line)">
            <th scope="col" className={`w-[60%] ${HEAD_CELL}`}>
              Key
            </th>
            <th scope="col" className={`w-[25%] ${HEAD_CELL}`}>
              Created
            </th>
            <th scope="col" className={HEAD_CELL}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-(--line)">
          {sorted.map((key) => (
            <tr key={key.keyId}>
              {/* max-w-0 lets an auto-layout cell truncate instead of pushing the other columns out. */}
              <td className="max-w-0 px-5 py-3 align-middle">
                <span className={`block truncate ${IDENTITY_TIER}`} title={key.label ?? undefined}>{key.label ?? "Unlabelled"}</span>
                <span className={`block font-mono break-all ${SECONDARY_TIER}`}>{key.keyId}</span>
              </td>
              <td className={`px-5 py-3 align-middle whitespace-nowrap ${SUPPORT_TIER}`}>
                <KeyDate at={key.createdAt} />
              </td>
              <td className="px-5 py-3 text-right align-middle">
                {key.revokedAt === null ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => onRevoke(key)}>
                    Revoke
                  </Button>
                ) : (
                  <span className={`whitespace-nowrap ${SUPPORT_TIER}`}>
                    Revoked <KeyDate at={key.revokedAt} />
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The UTC day, with the exact instant on hover: never relative, never localized. */
function KeyDate({ at }: { at: number }) {
  return (
    <time dateTime={fmtTs(at)} title={fmtTsShort(at)} className="tabular-nums">
      {fmtTs(at).slice(0, 10)}
    </time>
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
      const res = await withStepUp(() => revokeApiKey({ data: { keyId: target.keyId } }));
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
          {error ? <span className="block text-xs text-destructive-foreground">{error}</span> : null}
        </output>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction type="button" onClick={onConfirm} aria-busy={busy} disabled={busy}>
            {busy ? "Revoking…" : "Revoke key"}
          </AlertDialogAction>
        </AlertDialogFooter>
        {/* Nested: step-up for the revoke opens inside this dialog. */}
        <StepUpSheet />
      </AlertDialogContent>
    </AlertDialog>
  );
}

const API_GUIDE_URL = "https://docs.eccos.chat/sending-messages";

type SnippetInput = { wabaId?: string; gatewayOrigin?: string | null; apiKey?: string; to?: string };

/** The send request, with this workspace's WABA, a just-issued key and a recipient when known. */
export function sendSnippet({ wabaId, gatewayOrigin, apiKey, to }: SnippetInput): string {
  return `curl -X POST ${gatewayOrigin ?? "<GATEWAY_URL>"}/v1/wabas/${wabaId ?? "<WABA_ID>"}/messages \\
  -H "Authorization: Bearer ${apiKey ?? "<API_KEY>"}" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "${to || "<PHONE>"}", "type": "template", "template": {"name": "hello_world", "language": {"code": "en_US"}}}'`;
}

/** How a key is used: the send endpoint, with this workspace's WABA and a just-issued key when known. */
export function SendSnippet(input: SnippetInput) {
  const snippet = sendSnippet(input);
  return (
    <div>
      <pre className="m-0 overflow-x-auto border border-(--line) p-3 font-mono text-xs text-foreground">
        {snippet}
      </pre>
      <a
        href={API_GUIDE_URL}
        target="_blank"
        rel="noreferrer"
        className={`mt-2 inline-block text-sm ${INLINE_LINK}`}
      >
        Read the API guide
      </a>
    </div>
  );
}
