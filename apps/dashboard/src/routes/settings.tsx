import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  getSubscriberConfig,
  resubscribe,
  setSubscriberConfig,
  type SubscriberConfig,
} from "../server/gateway";
import { Page, Unreachable, styles } from "../ui";

export const Route = createFileRoute("/settings")({
  loader: () => getSubscriberConfig(),
  component: SettingsPage,
});

function SettingsPage() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <Page title="Settings">
        <Unreachable error={result.error} />
      </Page>
    );
  }
  return (
    <Page title="Settings">
      <SubscriberCard config={result.data} />
      <ResubscribeCard />
    </Page>
  );
}

/** Notice line rendered from a server-fn `Result` (green on success, red on error). */
type Notice = { ok: boolean; text: string };

function NoticeBox({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return <pre style={notice.ok ? styles.success : styles.errorBox}>{notice.text}</pre>;
}

function SubscriberCard({ config }: { config: SubscriberConfig }) {
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
      // The secret field is write-only: only send it when the operator typed a
      // new value, otherwise the gateway keeps the existing secret.
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
    <section style={styles.card}>
      <h2 style={styles.cardTitle}>Subscriber forwarding target</h2>
      <p style={styles.muted}>
        Current URL: <code style={styles.code}>{config.url ?? "—"}</code>
      </p>
      <p style={styles.muted}>
        Secret configured:{" "}
        <code style={styles.code}>{config.hasSecret ? "yes" : "no"}</code>
      </p>

      <form onSubmit={onSubmit} style={{ marginTop: 16 }}>
        <div style={styles.formRow}>
          <label style={styles.label} htmlFor="subscriber-url">
            Forwarding URL
          </label>
          <input
            id="subscriber-url"
            style={styles.input}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhook"
          />
        </div>
        <div style={styles.formRow}>
          <label style={styles.label} htmlFor="subscriber-secret">
            Signing secret
          </label>
          <input
            id="subscriber-secret"
            style={styles.input}
            type="password"
            value={secret}
            autoComplete="new-password"
            onChange={(e) => setSecret(e.target.value)}
            placeholder="leave blank to keep existing"
          />
          <p style={styles.hint}>
            Write-only. The stored secret is never displayed — only whether one is set.
          </p>
        </div>
        <button type="submit" style={styles.button} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>

      <NoticeBox notice={notice} />
    </section>
  );
}

function ResubscribeCard() {
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function onResubscribe() {
    setRunning(true);
    setNotice(null);
    try {
      const res = await resubscribe();
      if (!res.ok) {
        // Gateway unreachable / RPC threw.
        setNotice({ ok: false, text: res.error });
      } else if (res.data.ok) {
        setNotice({ ok: true, text: "Re-subscribed. Meta accepted the webhook subscription." });
      } else {
        // Reachable, but Meta rejected — e.g. callback URL not configured.
        setNotice({ ok: false, text: res.data.error });
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <section style={styles.card}>
      <h2 style={styles.cardTitle}>Re-subscribe</h2>
      <p style={styles.muted}>
        Re-run the Meta webhook subscription handshake for this app. Use this after
        changing the callback URL, or if Meta disabled the subscription.
      </p>
      <div style={{ marginTop: 14 }}>
        <button type="button" style={styles.button} disabled={running} onClick={onResubscribe}>
          {running ? "Re-subscribing…" : "Re-subscribe"}
        </button>
      </div>
      <NoticeBox notice={notice} />
    </section>
  );
}
