import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AUTH_ERROR_BANNER_CLASS } from "../auth/auth-page";
import { linkIsLive, linkStatusLine } from "../../lib/connect-link/status";
import { failureCopy } from "../../lib/failure";
import { followSignIn } from "../../lib/follow-sign-in";
import { type ConnectLinkView, type Result, openConnectLink } from "../../server/gateway";
import { CopyButton } from "./copy-button";
import { MACHINE_CLASS } from "./plain-table";

/** The workspace's connection link: copy it, replace it, and see how far its reader got. */
export function ConnectLinkButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        Copy connection link
      </Button>
      {open ? <ConnectLinkDialog onOpenChange={setOpen} /> : null}
    </>
  );
}

function ConnectLinkDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connection link</DialogTitle>
          <DialogDescription>
            Send this link to whoever holds the phone. They connect the number from their own computer, without an
            Eccos account. Valid for 7 days, for one connection.
          </DialogDescription>
        </DialogHeader>
        <ConnectLinkPanel />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's body, free of the dialog so it can be rendered on its own in tests. */
export function ConnectLinkPanel({ load = openConnectLink }: { load?: typeof openConnectLink }) {
  const [view, setView] = useState<Result<ConnectLinkView> | null>(null);
  // Only the call that makes a link returns its address: Eccos keeps a hash.
  const [url, setUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(true);

  // One request at a time: a second open or a double click must not make a second link.
  const inFlight = useRef(false);
  const request = useCallback(
    async (fresh: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      try {
        const next = await load({ data: { fresh } });
        setView(next);
        if (next.ok && next.data.url) setUrl(next.data.url);
      } catch (err) {
        if (!followSignIn(err)) setView({ ok: false, kind: "unreachable", error: String(err) });
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [load],
  );
  useEffect(() => void request(false), [request]);

  const link = view?.ok ? view.data.link : null;
  return (
    <>
      {view && !view.ok ? (
        <p className={AUTH_ERROR_BANNER_CLASS} role="alert">
          {failureCopy(view).detail}
        </p>
      ) : null}
      {url ? (
        <code className="block border border-(--line-strong) bg-(--ghost-fill) p-3 font-mono text-xs break-all text-foreground">
          {url}
        </code>
      ) : link ? (
        <p className="m-0 text-sm text-muted-foreground">
          {linkIsLive(link)
            ? "This link was sent already. Make a new one to get its address again; the old one stops working."
            : "Make a new link to connect another number."}
        </p>
      ) : null}
      <output className="block">
        {link ? (
          <>
            <span className={`block ${MACHINE_CLASS}`}>Status</span>
            <span className="mt-1 block text-sm text-foreground">{linkStatusLine(link)}</span>
          </>
        ) : pending ? (
          <span className="text-sm text-muted-foreground">Loading…</span>
        ) : null}
      </output>
      <div className="flex items-center gap-2">
        {url ? (
          <CopyButton key={url} value={url} label="Copy link" />
        ) : null}
        {/* The one thing left to do when there is no address to copy. */}
        <Button
          type="button"
          variant={url ? "outline" : "default"}
          disabled={pending || !view}
          onClick={() => void request(true)}
        >
          New link
        </Button>
      </div>
      {url ? (
        <p className="m-0 text-xs text-muted-foreground">A new link replaces this one, which stops working.</p>
      ) : null}
    </>
  );
}
