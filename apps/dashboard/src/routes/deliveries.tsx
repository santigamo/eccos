import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { listDeliveries, retryDelivery } from "../server/gateway";
import { Page, StatusTag, Unreachable, fmtTs, styles } from "../ui";

export const Route = createFileRoute("/deliveries")({
  loader: () => listDeliveries(),
  component: DeliveriesPage,
});

function DeliveriesPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [filter, setFilter] = useState("all");
  const [retrying, setRetrying] = useState<number | null>(null);

  if (!result.ok) {
    return (
      <Page title="Deliveries">
        <Unreachable error={result.error} />
      </Page>
    );
  }

  const rows = result.data;
  const statuses = Array.from(new Set(rows.map((d) => d.status))).sort();
  const visible = filter === "all" ? rows : rows.filter((d) => d.status === filter);

  async function onRetry(id: number) {
    setRetrying(id);
    try {
      await retryDelivery({ data: id });
      await router.invalidate();
    } finally {
      setRetrying(null);
    }
  }

  const filterControl =
    statuses.length > 0 ? (
      <select style={styles.select} value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="all">all statuses</option>
        {statuses.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    ) : undefined;

  return (
    <Page title="Deliveries" actions={filterControl}>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>ID</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Attempts</th>
              <th style={styles.th}>Next attempt</th>
              <th style={styles.th}>Last error</th>
              <th style={styles.th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td style={styles.empty} colSpan={6}>
                  {rows.length === 0 ? "No deliveries." : "No deliveries match this filter."}
                </td>
              </tr>
            ) : (
              visible.map((d) => (
                <tr key={d.id}>
                  <td style={styles.tdNum}>{d.id}</td>
                  <td style={styles.td}>
                    <StatusTag status={d.status} />
                  </td>
                  <td style={styles.tdNum}>{d.attempts}</td>
                  <td style={styles.tdMono}>{fmtTs(d.next_attempt_at)}</td>
                  <td style={styles.td}>{d.last_error ?? "—"}</td>
                  <td style={styles.td}>
                    <button
                      type="button"
                      style={styles.button}
                      disabled={retrying === d.id}
                      onClick={() => onRetry(d.id)}
                    >
                      {retrying === d.id ? "…" : "Retry"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
