import { useState, type FormEvent } from "react";
import { CONNECT_RETURN_PATH, connectWithToken } from "../../server/gateway";
import type { TokenWabaCandidate } from "../../server/gateway";
import { failureCopy, tokenConnectFailureCopy } from "../../lib/failure";
import { AUTH_ERROR_BANNER_CLASS } from "../auth/auth-page";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../reui/frame";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Attach a WhatsApp Business Account from a Meta access token (eccos-up9).
 *
 * ── WHY A PASTE BOX EXISTS AT ALL ───────────────────────────────────────────
 * Embedded Signup onboards *businesses*, so it never surfaces Meta's own Cloud
 * API test WABA — the free test number an App Review screencast has to be
 * filmed on. Pasting its token is the only way to attach it. This panel is the
 * whole of that path; without it the alternative is an admin API key and a
 * curl, which is a shortcut nobody should institutionalise.
 *
 * ── WHY IT IS HONEST INSTEAD OF HIDDEN ──────────────────────────────────────
 * Whether the paste can work is a property of the TOKEN, not of the
 * deployment: `debug_token` introspects only tokens issued by this
 * deployment's own Meta app, and the same install that can inspect the
 * operator's test token cannot inspect its customers'. So there is nothing to
 * hide the form behind — a deployment flag would either hide it from the one
 * operator it exists for, or show it to every customer anyway. Instead the
 * precondition is stated up front, the surface is subordinate (Settings, below
 * the forwarding target, a ghost submit — the page's one primary belongs to
 * Save), and the refusal names the flow that does work for a business.
 *
 * ── THE TOKEN ───────────────────────────────────────────────────────────────
 * It lives in React state and nowhere else: no storage, no URL, no query
 * string. It is held after a submit only because the multi-account resubmit
 * needs it, and it is cleared the moment a registration succeeds. Everything
 * that can act on it happens behind the private gateway binding.
 *
 * ── WHY IT ASKS FOR AN ID ───────────────────────────────────────────────────
 * `debug_token` may name no WABA at all: `target_ids` is nullable, and a
 * System User token with the account assigned as an asset was measured to
 * come back without it. So `no_waba` is a QUESTION, exactly as `multiple` is:
 * the gateway registered nothing and needs the operator to say which account.
 * The id field appears only then (progressive disclosure), never for a token
 * Meta already refused (`foreign_app`, `invalid_token` — no id can make those
 * usable), and once it has been answered a further refusal is reported by its
 * own code (`no_access`, `no_phone`) with the field kept, not by asking the
 * same question again.
 */
export function TokenConnectPanel() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set only by a `multiple` outcome; the choice that resolves it. */
  const [candidates, setCandidates] = useState<TokenWabaCandidate[] | null>(null);
  /** The id typed to answer `no_waba`. Sent only while `askWabaId` is true. */
  const [wabaId, setWabaId] = useState("");
  /** Set by a `no_waba` outcome; the question the id field answers. */
  const [askWabaId, setAskWabaId] = useState(false);

  function leaveAskMode() {
    setAskWabaId(false);
    setWabaId("");
  }

  async function submit(picked?: string) {
    // A candidate pick wins; otherwise the typed id, and only while the field
    // is showing — an id typed for one token must not ride silently on the
    // next.
    const selector = picked ?? (askWabaId ? wabaId.trim() || undefined : undefined);
    setBusy(true);
    setError(null);
    try {
      const res = await connectWithToken({
        data: { token, ...(selector ? { wabaId: selector } : {}) },
      });
      if (!res.ok) {
        setError(failureCopy(res).detail);
        return;
      }
      const outcome = res.data;
      if (!outcome.ok) {
        setCandidates(null);
        switch (outcome.code) {
          case "multiple":
            if (outcome.candidates?.length) {
              // `multiple` is a question, not a failure: the gateway registered
              // nothing and handed back the accounts to choose between.
              leaveAskMode();
              setCandidates(outcome.candidates);
              return;
            }
            break;
          case "no_waba":
            // Also a question: discovery found nothing, so ask for the id.
            // The gateway only answers this when no id was named, so showing
            // the field here can never be a loop.
            setAskWabaId(true);
            return;
          case "no_access":
          case "no_phone":
            // The answer was refused by its own code: keep the field, with
            // the id the refusal is about, and let the banner explain.
            setAskWabaId(true);
            if (selector && !wabaId.trim()) setWabaId(selector);
            break;
          case "foreign_app":
          case "invalid_token":
            // No id can make these usable; the field would be a lie.
            leaveAskMode();
            break;
          default:
            // `owned` / `failed`: the field stays as it was.
            break;
        }
        setError(tokenConnectFailureCopy(outcome.code, outcome.detail).detail);
        return;
      }
      // The credential leaves memory the instant it is no longer needed, and
      // the numbers table is a loader read — a navigation is the honest way to
      // show what provisioning just did rather than mirroring its state here.
      setToken("");
      leaveAskMode();
      setCandidates(null);
      window.location.assign(CONNECT_RETURN_PATH);
    } catch (err) {
      // The validator's own refusals land here, and they are written as
      // sentences for this panel. None of them can carry the pasted value:
      // every message names the SHAPE that was wrong, never what was typed.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          {/* Machine voice: the register the design contract gives panel
              titles (Inter, 11px, uppercase, tracking-wider). */}
          <FrameTitle className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Attach by token
          </FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            For a token issued by this deployment&apos;s own Meta app — the Cloud
            API test number&apos;s token, or a system-user token from the same
            app. A managed workspace connects its own number with{" "}
            <strong className="font-medium text-foreground">Connect with Meta</strong>{" "}
            on the Numbers page.
          </FrameDescription>
        </FrameHeader>

        {error ? (
          <p className={cn("mt-5", AUTH_ERROR_BANNER_CLASS)} role="alert">
            {error}
          </p>
        ) : null}

        <form onSubmit={onSubmit} aria-busy={busy} className="mt-5 flex flex-col gap-3">
          <div>
            <label
              htmlFor="connect-token"
              className="mb-1 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
            >
              Meta access token
            </label>
            {/* Masked: it is a live credential on a screen that may be shared,
                and this panel's own reason for existing is a screencast.
                Mono because what an operator checks here is character shape,
                not words. */}
            <Input
              id="connect-token"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              value={token}
              // Editing the token retires the question asked about the OLD
              // one: `askWabaId` and `wabaId` would otherwise survive the
              // change and an id typed for one token would ride silently on
              // the next. A new token deserves a fresh question.
              onChange={(event) => {
                setToken(event.target.value);
                leaveAskMode();
              }}
              className="font-mono"
              placeholder="EAAG…"
            />
            {/* The functional register, `·`-separated: what the surface costs
                to use, not how well we think it works. */}
            <p className="mt-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              This deployment&apos;s Meta app only · Test tokens expire in about
              a day
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Nothing is stored in this browser. When a test token expires,
              paste a fresh one here to renew it — the number stays attached.
            </p>
          </div>
          {askWabaId ? (
            <WabaIdQuestion value={wabaId} onChange={setWabaId} explain={error === null} />
          ) : null}
          {/* Ghost, never primary: Settings already spends its one primary on
              the forwarding target's Save. `w-fit self-start` because a submit
              stretched to the column reads as a banner, not a control. */}
          <Button type="submit" variant="outline" className="w-fit self-start" disabled={busy}>
            {busy ? "Attaching…" : "Attach number"}
          </Button>
        </form>

        {candidates ? (
          <TokenCandidateList
            candidates={candidates}
            busy={busy}
            onPick={(wabaId) => void submit(wabaId)}
          />
        ) : null}
      </FramePanel>
    </Frame>
  );
}

/**
 * The choice a `multiple` outcome asks for: one row per WhatsApp Business
 * Account the token reaches, and NOTHING registered until one is picked.
 *
 * Exported so its markup can be asserted directly — it only ever appears after
 * a submit, which static rendering cannot reach (the `SendTestForm` precedent).
 */
export function TokenCandidateList({
  candidates,
  busy,
  onPick,
}: {
  candidates: TokenWabaCandidate[];
  busy: boolean;
  onPick: (wabaId: string) => void;
}) {
  return (
    <div className="mt-5">
      <p className="m-0 text-sm text-muted-foreground">
        This token reaches more than one WhatsApp Business Account. Nothing was
        attached — pick the one to connect.
      </p>
      {/* The ghost-row anatomy of the /numbers connect fork: `--ghost-fill`
          under a `--line-strong` edge that turns green on hover. `gap-2`, not a
          shared 1px seam: these are controls at a fork, not table rows. */}
      <ul className="m-0 flex list-none flex-col gap-2 p-0 pt-3">
        {candidates.map((candidate) => (
          <li key={candidate.wabaId}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick(candidate.wabaId)}
              className={cn(
                "group flex w-full flex-col items-start gap-1 rounded-none border border-(--line-strong) bg-(--ghost-fill) p-4 text-left transition-colors",
                "hover:border-(--ghost-edge-hover) hover:bg-(--ghost-fill-hover)",
                "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              <span className="font-mono text-sm text-foreground">{candidate.wabaId}</span>
              <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                {candidate.phones.length > 0
                  ? candidate.phones
                      .map((phone) => phone.displayPhoneNumber || phone.phoneNumberId)
                      .join(" · ")
                  : "No phone number"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The question a `no_waba` outcome asks: which WhatsApp Business Account?
 *
 * `explain` carries the question sentence; the panel drops it once a banner
 * is explaining a refusal of the answer, so the field stays but the same
 * question is not asked twice. Exported for the same reason as
 * `TokenCandidateList`: it only ever appears after a submit.
 */
export function WabaIdQuestion({
  value,
  onChange,
  explain,
}: {
  value: string;
  onChange: (value: string) => void;
  explain: boolean;
}) {
  return (
    <div>
      {explain ? (
        <p className="m-0 mb-3 text-sm text-muted-foreground">
          Meta accepted this token but did not say which WhatsApp Business
          Account it reaches — a system-user token usually does not. Nothing
          was attached. Enter the account&apos;s id if you know it, and Meta
          will be asked whether this token can read it.
        </p>
      ) : null}
      <label
        htmlFor="connect-waba-id"
        className="mb-1 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
      >
        WhatsApp Business Account id
      </label>
      {/* Mono for the same reason as the token: what is checked here is
          character shape. Not masked: an id is an identifier, not a secret. */}
      <Input
        id="connect-waba-id"
        type="text"
        inputMode="numeric"
        required
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="font-mono"
        placeholder="1234567890123456"
      />
      {/* The functional register, `·`-separated: where the id is, and its shape. */}
      <p className="mt-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        Shown under WhatsApp accounts in Business settings · Digits only
      </p>
    </div>
  );
}
