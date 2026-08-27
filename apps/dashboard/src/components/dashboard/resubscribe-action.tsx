import { useState } from "react";
import { resubscribe } from "../../server/gateway";
import {
  Frame,
  FramePanel,
  FrameHeader,
  FrameTitle,
  FrameDescription,
} from "@/components/reui/frame";
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

export function ResubscribeAction({ wabaId }: { wabaId?: string }) {
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function onResubscribe() {
    setRunning(true);
    setNotice(null);
    try {
      const res = await resubscribe({ data: { wabaId } });
      if (!res.ok) {
        setNotice({ ok: false, text: res.error });
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
    <Frame variant="default" spacing="sm">
      <FramePanel fit>
        <FrameHeader>
          <FrameTitle>Re-subscribe</FrameTitle>
          <FrameDescription>
            Re-run the Meta webhook subscription handshake for this app. Use this after
            changing the callback URL, or if Meta disabled the subscription.
          </FrameDescription>
        </FrameHeader>
        <div className="mt-3">
          <Button
            variant="secondary"
            onClick={onResubscribe}
            disabled={running}
            aria-busy={running}
          >
            {running ? "Re-subscribing\u2026" : "Re-subscribe"}
          </Button>
        </div>
        <NoticeBox notice={notice} />
      </FramePanel>
    </Frame>
  );
}
