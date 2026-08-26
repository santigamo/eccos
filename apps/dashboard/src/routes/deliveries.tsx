import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { LogGrid } from "../components/grid/log-grid";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { listDeliveries, retryDelivery } from "../server/gateway";
import type { DeliveryRecord } from "../server/gateway";
import { Page, StatusTag, Unreachable, fmtTs } from "../ui";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAGE_SIZE = 50;
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

const columnHelper = createColumnHelper<DataGridFeatures, DeliveryRecord>();

function DeliveriesPage() {
  const result = Route.useLoaderData();
  const { status, before } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [retrying, setRetrying] = useState<number | null>(null);
  const rows = useMemo(() => (result.ok ? result.data : []), [result]);

  if (!result.ok) {
    return (
      <Page title="Deliveries">
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
    try {
      await retryDelivery({ data: id });
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
      meta: { cellClassName: "text-right whitespace-nowrap" },
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
      meta: { cellClassName: "text-right whitespace-nowrap" },
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
        return (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-none"
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

  return (
    <Page title="Deliveries" actions={filterControl}>
      <LogGrid
        columns={deliveriesColumns}
        data={rows}
        emptyMessage={
          status || before !== undefined
            ? "No deliveries match this view."
            : "No deliveries."
        }
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
