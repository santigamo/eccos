import { useState } from "react";
import { resubscribe } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { Button } from "@/components/ui/button";

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

/**
 * Re-run Meta's webhook subscription handshake for this WABA.
 *
 * It renders BARE — no frame of its own. It used to be a panel on /settings,
 * where it stood alone; it now sits inside the "From Meta" panel on /webhooks,
 * next to the callback URL it re-subscribes. That is where a developer looks
 * for it: the page shows both legs of the plumbing, Meta → Eccos here and
 * Eccos → your receiver above, and this action belongs to the first one.
 *
 * A ghost, like every other control on that page: the one primary belongs to
 * the forwarding target's Save.
 */
export function ResubscribeAction({ wabaId }: { wabaId?: string }) {
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function onResubscribe() {
    setRunning(true);
    setNotice(null);
    try {
      const res = await resubscribe({ data: { wabaId } });
      if (!res.ok) {
        setNotice({ ok: false, text: failureCopy(res).detail });
      } else if (res.data.ok) {
        setNotice({ ok: true, text: "Re-subscribed. Meta accepted the webhook subscription." });
      } else {
        setNotice({ ok: false, text: res.data.error });
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
        Re-run the Meta webhook subscription handshake for this app. Use this after
        changing the callback URL, or if Meta disabled the subscription.
      </p>
      <div className="mt-3">
        <Button
          variant="outline"
          onClick={onResubscribe}
          disabled={running}
          aria-busy={running}
        >
          {running ? "Re-subscribing…" : "Re-subscribe"}
        </Button>
      </div>
      <NoticeBox notice={notice} />
    </div>
  );
}
