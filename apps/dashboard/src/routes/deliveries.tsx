import { useMemo, useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { GridEmptyState } from "../components/grid/empty-state";
import { LogGrid } from "../components/grid/log-grid";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { listDeliveries, retryDelivery } from "../server/gateway";
import type { DeliveryRecord } from "../server/gateway";
import { Page, StatusTag, Unreachable, fmtTs } from "../ui";
import { Button } from "@/components/ui/button";
import { normalizeSearchBefore, normalizeSearchStatus, normalizeSearchWabaId } from "../lib/search";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAGE_SIZE = 50;
const KNOWN_STATUSES = ["pending", "delivered", "failed"] as const;

type DeliveriesSearch = { status?: string; before?: number; wabaId?: string };

export const Route = createFileRoute("/deliveries")({
  validateSearch: (search: Record<string, unknown>): DeliveriesSearch => {
    const status = normalizeSearchStatus(search.status);
    const before = normalizeSearchBefore(search.before);
    const wabaId = normalizeSearchWabaId(search.wabaId);
    return { status, before, wabaId };
  },
  loaderDeps: ({ search }) => ({ status: search.status, before: search.before, wabaId: search.wabaId }),
  loader: ({ deps }) =>
    listDeliveries({ data: { status: deps.status, before: deps.before, wabaId: deps.wabaId } }),
  component: DeliveriesPage,
});

const columnHelper = createColumnHelper<DataGridFeatures, DeliveryRecord>();

function DeliveriesPage() {
  const result = Route.useLoaderData();
  const { status, before, wabaId } = Route.useSearch();
  const scope = useLoaderData({ from: "__root__" });
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [retrying, setRetrying] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const rows = useMemo(() => (result.ok ? result.data : []), [result]);

  if (!result.ok) {
    return (
      <Page title="Deliveries" kicker="Logs">
        <Unreachable error={result.error} />
      </Page>
    );
  }

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
    setRetryError(null);
    try {
      const retry = await retryDelivery({ data: { id, wabaId: wabaId ?? (scope.ok && scope.data.stage === "ready" ? scope.data.scope.selectedWabaId : undefined) } });
      if (!retry.ok) {
        setRetryError(retry.error);
        return;
      }
      await router.invalidate();
    } finally {
      setRetrying(null);
    }
  }

  const deliveriesColumns = [
    columnHelper.accessor("id", {
      id: "id",
      header: "ID",
      cell: (info) => (
        <span className="font-mono text-xs tabular-nums">{info.getValue()}</span>
      ),
      meta: {
        headerClassName: "text-right",
        cellClassName: "text-right whitespace-nowrap",
      },
    }),
    columnHelper.accessor("phone_number_id", {
      id: "phone_number_id",
      header: "Phone ID",
      cell: (info) => <span className="font-mono text-xs">{info.getValue() ?? "\u2014"}</span>,
      meta: { cellClassName: "text-foreground/80 break-all" },
    }),
    columnHelper.accessor("status", {
      id: "status",
      header: "Status",
      cell: (info) => <StatusTag status={info.getValue()} />,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("attempts", {
      id: "attempts",
      header: "Attempts",
      cell: (info) => info.getValue(),
      meta: {
        headerClassName: "text-right",
        cellClassName: "text-right whitespace-nowrap",
      },
    }),
    columnHelper.accessor("next_attempt_at", {
      id: "next_attempt_at",
      header: "Next attempt",
      cell: (info) => (
        <span className="font-mono text-xs">{fmtTs(info.getValue())}</span>
      ),
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("last_error", {
      id: "last_error",
      header: "Last error",
      cell: (info) => info.getValue() ?? "\u2014",
      meta: { cellClassName: "text-foreground/80 break-words" },
    }),
    columnHelper.display({
      id: "action",
      header: "Action",
      cell: (info) => {
        const record = info.row.original;
        // Retry is only meaningful on a failed delivery: a pending one is
        // already queued and a delivered one is done. Every other row holds
        // the column's rhythm with a muted em-dash instead of a dead button.
        if (record.status !== "failed") {
          return <span className="text-muted-foreground">—</span>;
        }
        return (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-none"
            aria-label={`Retry delivery ${record.id}`}
            disabled={retrying === record.id}
            onClick={() => onRetry(record.id)}
          >
            {retrying === record.id ? "\u2026" : "Retry"}
          </Button>
        );
      },
    }),
  ];

  function onFilterChange(value: string) {
    navigate({
      search: (prev) => ({ ...prev, status: value === "all" ? undefined : value, before: undefined }),
    });
  }

  const filterControl = (
    <>
      <label className="sr-only" htmlFor="delivery-status-filter">
        Filter deliveries by status
      </label>
      <Select
        value={activeStatus}
        onValueChange={(value) => onFilterChange(value ?? "all")}
      >
        <SelectTrigger id="delivery-status-filter" size="sm" className="h-7 rounded-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" className="min-w-(--anchor-width)">
          <SelectItem value="all">all statuses</SelectItem>
          {statuses.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );

  // A narrowed view that came back empty is a different message from a gateway
  // that has never forwarded anything: the first one has a way out.
  const isNarrowed = status !== undefined || before !== undefined;

  const emptyState = isNarrowed ? (
    <GridEmptyState
      label="NO MATCHES"
      description="No deliveries match this view."
      action={
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-sm"
          onClick={() => navigate({ search: () => ({ wabaId }) })}
        >
          Clear filters
        </Button>
      }
    />
  ) : (
    <GridEmptyState
      label="NO DELIVERIES YET"
      description="Forward attempts to your subscriber will appear here."
    />
  );

  return (
    <Page title="Deliveries" kicker="Logs" actions={filterControl}>
      {retryError ? <p className="mb-4 border-l-2 border-destructive px-3 py-2 text-sm text-destructive" role="alert">{retryError}</p> : null}
      <LogGrid
        columns={deliveriesColumns}
        data={rows}
        emptyMessage={emptyState}
        getRowId={(row) => String(row.id)}
      />

      <div className="flex gap-2 mt-3 justify-end">
        {before !== undefined ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-none"
            onClick={() => navigate({ search: (prev) => ({ ...prev, before: undefined }) })}
          >
            ← Latest
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-none"
          disabled={!canLoadOlder}
          onClick={() =>
            oldestId !== undefined &&
            navigate({ search: (prev) => ({ ...prev, before: oldestId }) })
          }
        >
          Load older →
        </Button>
      </div>
    </Page>
  );
}
