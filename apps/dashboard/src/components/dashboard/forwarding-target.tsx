import { useEffect, useState, type FormEvent } from "react";
import { setSubscriberConfig, type SubscriberConfig } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import {
  Frame,
  FramePanel,
  FrameHeader,
  FrameTitle,
  FrameDescription,
} from "@/components/reui/frame";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * The forwarding target: where this WhatsApp Business Account's events go.
 *
 * ── WHY IT IS ROUTER-FREE ───────────────────────────────────────────────────
 * Re-reading the loader after a write is the ROUTE's job, because the route
 * owns the data — the same split `numbers.tsx` uses for its re-check action.
 * It also makes this panel renderable by `renderToStaticMarkup`, which is the
 * only kind of rendering this suite has (no DOM, by choice).
 *
 * ── WHAT THE SECRET CAN AND CANNOT DO ───────────────────────────────────────
 * The stored secret is never returned by any read (`SubscriberConfig` exposes
 * `hasSecret` and nothing else — a stated property in docs/threat-model.md), so
 * this box is write-only: `Generate` fills it in the browser, `Show` can reveal
 * what has not been saved yet, and both are gone the moment Save clears the
 * field. The console reveals only what it is still holding.
 *
 * An untouched box means KEEP, and now it can only mean that: the contract
 * refuses an empty-string secret outright, so "I did not touch it" and "I want
 * it gone" no longer share a spelling (`SetSubscriberConfigInput`).
 */
type Notice = { ok: boolean; text: string };

function NoticeBox({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <output
      aria-live="polite"
      aria-atomic="true"
      className={
        notice.ok
          ? "bg-success/10 text-success mt-3 block border border-success/20 p-3 text-xs whitespace-pre-wrap break-words"
          : "bg-destructive/10 text-destructive mt-3 block border border-destructive/20 p-3 text-xs whitespace-pre-wrap break-words"
      }
    >
      {notice.text}
    </output>
  );
}

/** The machine voice: Inter, 11px, uppercase, wide tracking (the design
 * contract's functional register — panel titles, form labels, captions). */
const MACHINE_CLASS = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
const LABEL_CLASS = `mb-1 block ${MACHINE_CLASS}`;

/** 32 bytes as hex, minted in the browser. The server never proposes a secret:
 * a value that travelled to be shown would have to travel back to be saved. */
function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ForwardingTargetPanel({
  config,
  wabaId,
  onSaved,
}: {
  config: SubscriberConfig;
  wabaId?: string;
  /** Called after a write lands, so the route can re-read its loader. */
  onSaved?: () => void;
}) {
  const [url, setUrl] = useState(config.url ?? "");
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    setUrl(config.url ?? "");
  }, [config.url]);

  async function write(input: { url: string | null; secret?: string }, done: string) {
    setSaving(true);
    setNotice(null);
    try {
      const res = await setSubscriberConfig({ data: { ...input, wabaId } });
      if (res.ok) {
        // The field empties on success and stays empty: what is stored is not
        // readable, so keeping the typed value on screen would be the console
        // showing a secret it can no longer prove is the stored one.
        setSecret("");
        setReveal(false);
        setConfirmingRemove(false);
        setNotice({ ok: true, text: done });
        onSaved?.();
      } else {
        setNotice({ ok: false, text: failureCopy(res).detail });
      }
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = secret.trim();
    // `secret` is OMITTED when untouched, never sent as "": the empty string is
    // refused by both this console's validator and the gateway, precisely so a
    // blank box cannot silently mean two things.
    void write({ url: url.trim(), ...(trimmed ? { secret: trimmed } : {}) }, "Saved. Forwarding target updated.");
  }

  const hasTarget = config.url !== null;

  return (
    <Frame variant="default" spacing="lg" className="max-w-xl">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className={MACHINE_CLASS}>Forwarding target</FrameTitle>
          {hasTarget ? null : (
            /* Data rule 6: structure, not a lone muted line — and no action of
               its own, because the form below IS the action.

               Both halves of the sentence are load-bearing. The first is true
               only because the gateway HOLDS the queue while no target exists
               (Phase 1.1); before that, events were being spent against a
               destination that did not exist. The second is there because the
               hold is BOUNDED: a held row past the content window is deleted
               like any other expired content (`pruneExpired` in
               apps/gateway/src/gateway.ts, docs/privacy.md). "Queued, not lost"
               on its own would promise an archive this gateway deliberately
               does not keep. */
            <FrameDescription className="max-w-prose text-pretty">
              <span className={`block ${MACHINE_CLASS}`}>No forwarding target</span>
              <span className="mt-1.5 block">
                Events are queued, not attempted — nothing fails for want of a
                receiver. Name one and the backlog goes out as soon as it is
                saved; held events expire with the retention window like
                everything else, so the wait is bounded.
              </span>
            </FrameDescription>
          )}
        </FrameHeader>

        <form onSubmit={onSubmit} aria-busy={saving} className="mt-5 flex flex-col gap-4">
          <div>
            <label htmlFor="subscriber-url" className={LABEL_CLASS}>
              Forwarding URL
            </label>
            {/* Mono: what an operator checks in a URL is character shape — a
                path typo, a stray port — not words. */}
            <Input
              id="subscriber-url"
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="font-mono"
              placeholder="https://example.com/webhook"
            />
          </div>

          <SigningSecretField
            value={secret}
            revealed={reveal}
            hasStoredSecret={config.hasSecret}
            onChange={setSecret}
            onGenerate={() => {
              setSecret(generateSecret());
              setReveal(true);
            }}
            onToggleReveal={() => setReveal((shown) => !shown)}
          />

          {/* The page's ONE primary. Everything else on /webhooks is a ghost. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" className="w-fit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {hasTarget && !confirmingRemove ? (
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                disabled={saving}
                onClick={() => setConfirmingRemove(true)}
              >
                Remove target
              </Button>
            ) : null}
          </div>
        </form>

        {confirmingRemove ? (
          <RemoveTargetConfirm
            busy={saving}
            onCancel={() => setConfirmingRemove(false)}
            onConfirm={() => void write({ url: null }, "Removed. Events are waiting for a target.")}
          />
        ) : null}

        <NoticeBox notice={notice} />
      </FramePanel>
    </Frame>
  );
}

/**
 * The signing secret box, with its two controls.
 *
 * Exported so both of its states can be asserted directly: `Show` exists ONLY
 * while an unsaved value is in the field, and that rule is invisible to a
 * static render of the panel, which always starts empty (the `TokenCandidateList`
 * precedent — this suite has no DOM and cannot type into an input).
 */
export function SigningSecretField({
  value,
  revealed,
  hasStoredSecret,
  onChange,
  onGenerate,
  onToggleReveal,
}: {
  value: string;
  revealed: boolean;
  hasStoredSecret: boolean;
  onChange: (value: string) => void;
  onGenerate: () => void;
  onToggleReveal: () => void;
}) {
  const unsaved = value.length > 0;
  return (
    <div>
      <label htmlFor="subscriber-secret" className={LABEL_CLASS}>
        Signing secret
      </label>
      <div className="flex items-start gap-2">
        <Input
          id="subscriber-secret"
          // `text` only while the value is still in this browser and unsaved.
          // Nothing that has been persisted can ever come back to be shown.
          type={revealed && unsaved ? "text" : "password"}
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          className="font-mono"
          placeholder={hasStoredSecret ? "leave blank to keep the stored secret" : "no secret set"}
        />
        <Button type="button" variant="outline" onClick={onGenerate}>
          Generate
        </Button>
        {unsaved ? (
          <Button type="button" variant="outline" onClick={onToggleReveal}>
            {revealed ? "Hide" : "Show"}
          </Button>
        ) : null}
      </div>
      {/* The functional register: what the field costs to use, and the way back
          when it is lost. Rotation is the recovery path precisely because the
          queue keeps retrying while the two sides disagree — nothing is dropped
          in the window where the receiver is still verifying the old key. */}
      <p className={`mt-2 ${MACHINE_CLASS}`}>
        Write-only · Lost it? set a new one here and in your receiver — deliveries
        retry while the two disagree
      </p>
    </div>
  );
}

/**
 * The confirm step for removing a target.
 *
 * Two clicks, not a `window.confirm`: a native dialog is the one surface in
 * this console that cannot be styled, and this one has something specific to
 * say — removal is not destructive to the queue. Exported for the same reason
 * as `SigningSecretField`: it only exists after a click.
 */
export function RemoveTargetConfirm({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 border-t border-(--line) pt-4">
      <p className="m-0 text-sm text-muted-foreground">
        Remove the forwarding target? Nothing is forwarded afterwards, and events
        wait in the queue instead of failing against a destination that is gone.
        The signing secret is kept.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onConfirm}>
          {busy ? "Removing…" : "Remove target"}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
