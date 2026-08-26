import { useState, type FormEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  setSubscriberConfig,
  type SubscriberConfig,
} from "../../server/gateway";
import {
  Frame,
  FramePanel,
  FrameHeader,
  FrameTitle,
  FrameDescription,
} from "@/components/reui/frame";
import { Input } from "@/components/ui/input";
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

export function SubscriberForm({ config }: { config: SubscriberConfig }) {
  const router = useRouter();
  const [url, setUrl] = useState(config.url ?? "");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const trimmed = secret.trim();
      const payload = trimmed ? { url, secret: trimmed } : { url };
      const res = await setSubscriberConfig({ data: payload });
      if (res.ok) {
        setSecret("");
        setNotice({ ok: true, text: "Saved. Forwarding target updated." });
        await router.invalidate();
      } else {
        setNotice({ ok: false, text: res.error });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Frame variant="default" spacing="sm">
      <FramePanel fit>
        <FrameHeader>
          <FrameTitle>Subscriber forwarding target</FrameTitle>
          <FrameDescription>
            Current URL: <code className="bg-muted text-foreground px-1 text-xs">{config.url ?? "\u2014"}</code>
            {" \u00B7 "}
            Secret configured:{" "}
            <code className="bg-muted text-foreground px-1 text-xs">{config.hasSecret ? "yes" : "no"}</code>
          </FrameDescription>
        </FrameHeader>
        <form
          onSubmit={onSubmit}
          aria-busy={saving}
          className="mt-3 flex flex-col gap-3"
        >
          <div>
            <label
              htmlFor="subscriber-url"
              className="block mb-1 text-[11px] font-medium text-muted-foreground tracking-wider uppercase"
            >
              Forwarding URL
            </label>
            <Input
              id="subscriber-url"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhook"
            />
          </div>
          <div>
            <label
              htmlFor="subscriber-secret"
              className="block mb-1 text-[11px] font-medium text-muted-foreground tracking-wider uppercase"
            >
              Signing secret
            </label>
            <Input
              id="subscriber-secret"
              type="password"
              value={secret}
              autoComplete="new-password"
              onChange={(e) => setSecret(e.target.value)}
              placeholder="leave blank to keep existing"
            />
            <p className="mt-1 text-muted-foreground text-xs">
              Write-only. The stored secret is never displayed {"\u2014"} only whether one is set.
            </p>
          </div>
          {/* `self-start`: a submit button in a flex column stretches to the
              column width by default, which reads as a banner, not a control. */}
          <Button type="submit" className="w-fit self-start" disabled={saving}>
            {saving ? "Saving\u2026" : "Save"}
          </Button>
        </form>
        <NoticeBox notice={notice} />
      </FramePanel>
    </Frame>
  );
}
