import type { CSSProperties, ReactNode } from "react";

/** Format an epoch-ms timestamp as an ISO string, tolerating null / garbage. */
export function fmtTs(ms: number | string | null | undefined): string {
  if (ms == null || ms === "") return "—";
  const n = Number(ms);
  if (!Number.isFinite(n)) return "—";
  return new Date(n).toISOString();
}

const STATUS_COLORS: Record<string, string> = {
  healthy: "#37b24d",
  delivered: "#37b24d",
  sent: "#37b24d",
  approved: "#37b24d",
  degraded: "#f0a020",
  pending: "#f0a020",
  unhealthy: "#e03131",
  failed: "#e03131",
  rejected: "#e03131",
};

/** Colored status label; unknown statuses render in the neutral text color. */
export function StatusTag({ status }: { status: string }) {
  const color = STATUS_COLORS[status.toLowerCase()] ?? "#aeb6c2";
  return <span style={{ color, fontWeight: 600 }}>{status}</span>;
}

/** Error card for the `{ ok: false }` (gateway unreachable / RPC threw) state. */
export function Unreachable({ error }: { error: string }) {
  return (
    <section style={styles.card}>
      <h2 style={styles.cardTitle}>Gateway unreachable</h2>
      <p style={styles.muted}>
        The dashboard could not reach the gateway over the{" "}
        <code style={styles.code}>GATEWAY</code> service binding.
      </p>
      <pre style={styles.errorBox}>{error}</pre>
    </section>
  );
}

/** Page shell: title + optional right-aligned controls, then children. */
export function Page({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.title}>{title}</h1>
        {actions}
      </header>
      {children}
    </main>
  );
}

export const styles = {
  main: { maxWidth: 1080, margin: "0 auto", padding: "28px 20px 64px" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 20,
  },
  title: { margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "0.02em" },
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
  tableWrap: {
    background: "#11161f",
    border: "1px solid #1d2531",
    borderRadius: 10,
    overflowX: "auto",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    color: "#8a93a2",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: 11,
    fontWeight: 600,
    borderBottom: "1px solid #1d2531",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "9px 12px",
    borderBottom: "1px solid #161c26",
    color: "#aeb6c2",
    verticalAlign: "top",
  },
  tdMono: {
    padding: "9px 12px",
    borderBottom: "1px solid #161c26",
    color: "#e6e9ef",
    verticalAlign: "top",
    wordBreak: "break-all",
  },
  tdNum: {
    padding: "9px 12px",
    borderBottom: "1px solid #161c26",
    color: "#e6e9ef",
    textAlign: "right",
    verticalAlign: "top",
  },
  empty: { margin: 0, padding: 24, color: "#7a8290", fontSize: 13, textAlign: "center" },
  muted: { margin: "8px 0 0", color: "#7a8290", fontSize: 13 },
  code: { background: "#1d2531", padding: "1px 6px", borderRadius: 4, fontSize: 12 },
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
  button: {
    background: "#1d2531",
    border: "1px solid #2a3546",
    color: "#e6e9ef",
    borderRadius: 6,
    padding: "4px 12px",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  select: {
    background: "#11161f",
    color: "#e6e9ef",
    border: "1px solid #1d2531",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 13,
    fontFamily: "inherit",
  },
} satisfies Record<string, CSSProperties>;
