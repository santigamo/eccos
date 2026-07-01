import type { CSSProperties } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  getGatewayStatus,
  type GatewayStatus,
  type Health,
} from "../server/gateway";

export const Route = createFileRoute("/")({
  loader: () => getGatewayStatus(),
  component: StatusPage,
});

const HEALTH_COLORS: Record<Health, string> = {
  healthy: "#37b24d",
  degraded: "#f0a020",
  unhealthy: "#e03131",
};

function StatusPage() {
  const result = Route.useLoaderData();

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>eccos</h1>
          <p style={styles.subtitle}>operator console</p>
        </div>
        {result.ok ? (
          <HealthBadge health={result.status.health} />
        ) : (
          <HealthBadge health="unhealthy" label="unreachable" />
        )}
      </header>

      {result.ok ? (
        <StatusView status={result.status} />
      ) : (
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>Gateway unreachable</h2>
          <p style={styles.muted}>
            The dashboard could not reach the gateway over the{" "}
            <code style={styles.code}>GATEWAY</code> service binding.
          </p>
          <pre style={styles.errorBox}>{result.error}</pre>
          <p style={styles.muted}>
            Start the gateway worker (<code style={styles.code}>eccos</code>) and
            reload.
          </p>
        </section>
      )}
    </main>
  );
}

function StatusView({ status }: { status: GatewayStatus }) {
  const { connection, counts } = status;
  return (
    <>
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Connection</h2>
        <dl style={styles.dl}>
          <Field label="WABA ID" value={connection.wabaId} />
          <Field label="Phone number ID" value={connection.phoneNumberId} />
          <Field label="Display phone" value={connection.displayPhone} />
          <Field label="Connected at" value={connection.connectedAt} />
        </dl>
      </section>

      <section style={styles.grid}>
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Inbound</h2>
          <p style={styles.bigNumber}>{counts.inbound}</p>
          <p style={styles.muted}>events received</p>
        </div>
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Outbound</h2>
          <CountTable counts={counts.outbound} />
        </div>
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Deliveries</h2>
          <CountTable counts={counts.deliveries} />
        </div>
      </section>

      <p style={styles.footer}>
        {status.name} · v{status.version}
      </p>
    </>
  );
}

function HealthBadge({ health, label }: { health: Health; label?: string }) {
  const color = HEALTH_COLORS[health];
  return (
    <span
      style={{
        ...styles.badge,
        color,
        background: `${color}1f`,
        border: `1px solid ${color}`,
      }}
    >
      <span style={{ ...styles.dot, background: color }} />
      {label ?? health}
    </span>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={styles.field}>
      <dt style={styles.fieldLabel}>{label}</dt>
      <dd style={styles.fieldValue}>{value ?? "—"}</dd>
    </div>
  );
}

function CountTable({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return <p style={styles.muted}>none</p>;
  }
  return (
    <table style={styles.table}>
      <tbody>
        {entries.map(([status, n]) => (
          <tr key={status}>
            <td style={styles.tdStatus}>{status}</td>
            <td style={styles.tdNum}>{n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const styles = {
  main: { maxWidth: 880, margin: "0 auto", padding: "40px 20px 64px" },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 28,
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: "0.02em",
  },
  subtitle: { margin: "4px 0 0", color: "#7a8290", fontSize: 13 },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  dot: { width: 8, height: 8, borderRadius: "50%" },
  card: {
    background: "#11161f",
    border: "1px solid #1d2531",
    borderRadius: 10,
    padding: 20,
    marginBottom: 16,
  },
  cardTitle: {
    margin: "0 0 14px",
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "#8a93a2",
  },
  dl: { margin: 0, display: "grid", gap: 12 },
  field: {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    borderBottom: "1px solid #161c26",
    paddingBottom: 10,
  },
  fieldLabel: { margin: 0, color: "#7a8290" },
  fieldValue: {
    margin: 0,
    color: "#e6e9ef",
    textAlign: "right",
    wordBreak: "break-all",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 16,
  },
  bigNumber: { margin: 0, fontSize: 36, fontWeight: 700, color: "#e6e9ef" },
  table: { width: "100%", borderCollapse: "collapse" },
  tdStatus: {
    padding: "6px 0",
    color: "#aeb6c2",
    borderBottom: "1px solid #161c26",
  },
  tdNum: {
    padding: "6px 0",
    textAlign: "right",
    fontWeight: 600,
    borderBottom: "1px solid #161c26",
  },
  muted: { margin: "8px 0 0", color: "#7a8290", fontSize: 13 },
  code: {
    background: "#1d2531",
    padding: "1px 6px",
    borderRadius: 4,
    fontSize: 12,
  },
  errorBox: {
    margin: "12px 0 0",
    padding: 12,
    background: "#1a0f12",
    border: "1px solid #3a1c22",
    borderRadius: 8,
    color: "#ff9b9b",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: 13,
  },
  footer: { marginTop: 24, color: "#5c6473", fontSize: 12, textAlign: "center" },
} satisfies Record<string, CSSProperties>;
