import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { listDeliveries, retryDelivery } from "../server/gateway";
import { Page, StatusTag, Unreachable, fmtTs, styles } from "../ui";

// Matches the gateway's default operator page size (clampPage → 50). A full page
// means there may be older rows to page into; a short page is the end.
const PAGE_SIZE = 50;
// The delivery lifecycle vocabulary, so the filter is stable even when the
// current (server-filtered) page doesn't contain every status.
const KNOWN_STATUSES = ["pending", "delivered", "failed"] as const;

type DeliveriesSearch = { status?: string; before?: number };

export const Route = createFileRoute("/deliveries")({
  validateSearch: (search: Record<string, unknown>): DeliveriesSearch => {
    const status =
      typeof search.status === "string" && search.status.length > 0
        ? search.status
        : undefined;
    const beforeNum = Number(search.before);
    const before =
      Number.isFinite(beforeNum) && beforeNum > 0 ? Math.floor(beforeNum) : undefined;
    return { status, before };
  },
  loaderDeps: ({ search }) => ({ status: search.status, before: search.before }),
  loader: ({ deps }) =>
    listDeliveries({ data: { status: deps.status, before: deps.before } }),
  component: DeliveriesPage,
});

function DeliveriesPage() {
  const result = Route.useLoaderData();
  const { status, before } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [retrying, setRetrying] = useState<number | null>(null);

  if (!result.ok) {
    return (
      <Page title="Deliveries">
        <Unreachable error={result.error} />
      </Page>
    );
  }

  const rows = result.data;
  const activeStatus = status ?? "all";
  const statuses = Array.from(
    new Set<string>([
      ...KNOWN_STATUSES,
      ...rows.map((d) => d.status),
      ...(status ? [status] : []),
    ]),
  ).sort();

  const oldestId = rows.at(-1)?.id;
  const canLoadOlder = rows.length === PAGE_SIZE && oldestId !== undefined;

  async function onRetry(id: number) {
    setRetrying(id);
    try {
      await retryDelivery({ data: id });
      await router.invalidate();
    } finally {
      setRetrying(null);
    }
  }

  function onFilterChange(value: string) {
    // Switching filter resets pagination back to the latest page.
    navigate({
      search: (prev) => ({ ...prev, status: value === "all" ? undefined : value, before: undefined }),
    });
  }

  const filterControl = (
    <select
      style={styles.select}
      value={activeStatus}
      onChange={(e) => onFilterChange(e.target.value)}
    >
      <option value="all">all statuses</option>
      {statuses.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );

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
            {rows.length === 0 ? (
              <tr>
                <td style={styles.empty} colSpan={6}>
                  {status || before !== undefined
                    ? "No deliveries match this view."
                    : "No deliveries."}
                </td>
              </tr>
            ) : (
              rows.map((d) => (
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

      <div style={pager}>
        {before !== undefined ? (
          <button
            type="button"
            style={styles.button}
            onClick={() => navigate({ search: (prev) => ({ ...prev, before: undefined }) })}
          >
            ← Latest
          </button>
        ) : null}
        <button
          type="button"
          style={styles.button}
          disabled={!canLoadOlder}
          onClick={() =>
            oldestId !== undefined &&
            navigate({ search: (prev) => ({ ...prev, before: oldestId }) })
          }
        >
          Load older →
        </button>
      </div>
    </Page>
  );
}

const pager = {
  display: "flex",
  gap: 8,
  marginTop: 14,
  justifyContent: "flex-end",
} as const;
