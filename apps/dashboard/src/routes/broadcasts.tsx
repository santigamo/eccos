import { useMemo } from "react";
import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { GridEmptyState } from "../components/grid/empty-state";
import { GridPending } from "../components/grid/grid-pending";
import { LogGrid } from "../components/grid/log-grid";
import { LogPager } from "../components/logs/log-pager";
import { normalizeSearchTrail, type PageTrail } from "../lib/page-trail";
import { RefreshControls } from "../components/logs/refresh-controls";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { FailureView } from "../components/dashboard/failure";
import { useLiveRefresh } from "../hooks/use-live-refresh";
import { attemptedCount, broadcastStateLabel, normalizeBroadcastId } from "../lib/broadcasts";
import { loaderFailure } from "../lib/failure";
import { LIVE_STALE_MS } from "../lib/route-stale";
import { normalizeSearchWabaId } from "../lib/search";
import { listBroadcasts } from "../server/gateway";
import type { BroadcastSummary } from "../server/gateway";
import { COUNT_LINK, Page, StatusTag, fmtTs } from "../ui";

/**
 * ── BROADCASTS ──────────────────────────────────────────────────────────────
 * One approved template sent to many recipients, paced by the gateway. The
 * list is the campaigns; the recipients live one click down. Counts speak the
 * Eccos → Meta hop (`sent` / `failed`); Delivered and Read are Meta's later
 * receipts for the messages that were sent.
 */

type BroadcastsSearch = { wabaId?: string; cursor?: string; trail?: PageTrail };

export const Route = createFileRoute("/broadcasts")({
  staleTime: LIVE_STALE_MS,
  validateSearch: (search: Record<string, unknown>): BroadcastsSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    cursor: normalizeBroadcastId(search.cursor),
    trail: normalizeSearchTrail(search.trail, search.cursor),
  }),
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId, cursor: search.cursor }),
  loader: ({ deps }) => listBroadcasts({ data: deps }).catch(loaderFailure),
  component: BroadcastsPage,
  pendingComponent: () => (
    <GridPending title="Broadcasts" kicker="Sending" columns={broadcastColumns()} />
  ),
});

const columnHelper = createColumnHelper<DataGridFeatures, BroadcastSummary>();

const numeric = {
  headerClassName: "text-right",
  cellClassName: "text-right whitespace-nowrap",
};

function broadcastColumns(wabaId?: string, showPhone = false) {
  return [
    columnHelper.accessor("createdAt", {
      id: "created",
      header: "Created",
      cell: (info) => <span className="font-mono text-xs">{fmtTs(info.getValue())}</span>,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    // The row's door: the same anatomy as the MESSAGE cell on /messages.
    columnHelper.accessor("template", {
      id: "template",
      header: "Template",
      cell: (info) => {
        const row = info.row.original;
        return (
          <Link
            to="/broadcasts/$broadcastId"
            params={{ broadcastId: row.id }}
            search={wabaId ? { wabaId } : {}}
            onClick={(event) => event.stopPropagation()}
            className={`text-foreground ${COUNT_LINK} hover:text-ink`}
          >
            {row.template.name}
            <span className="text-muted-foreground"> · {row.template.language}</span>
          </Link>
        );
      },
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("status", {
      id: "state",
      header: "State",
      cell: (info) => <StatusTag status={broadcastStateLabel(info.row.original)} />,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.display({
      id: "progress",
      header: "Progress",
      cell: (info) => {
        const { counts, total } = info.row.original;
        return (
          <span className="font-mono text-xs tabular-nums">
            {attemptedCount(counts)} / {total}
          </span>
        );
      },
      meta: numeric,
    }),
    columnHelper.display({
      id: "sent",
      header: "Sent",
      cell: (info) => <span className="font-mono text-xs tabular-nums">{info.row.original.counts.sent}</span>,
      meta: numeric,
    }),
    columnHelper.display({
      id: "failed",
      header: "Failed",
      cell: (info) => {
        const { failed, unknown } = info.row.original.counts;
        if (failed + unknown === 0) return <span className="font-mono text-xs tabular-nums">0</span>;
        return (
          <span className="inline-flex gap-2">
            {(
              [
                ["failed", failed],
                ["unknown", unknown],
              ] as const
            )
              .filter(([, count]) => count > 0)
              .map(([status, count]) => (
                <Link
                  key={status}
                  to="/broadcasts/$broadcastId"
                  params={{ broadcastId: info.row.original.id }}
                  search={{ status, ...(wabaId ? { wabaId } : {}) }}
                  onClick={(event) => event.stopPropagation()}
                  className={`font-mono text-xs tabular-nums text-destructive-foreground ${COUNT_LINK}`}
                >
                  {count}
                  {status === "unknown" ? " unknown" : ""}
                </Link>
              ))}
          </span>
        );
      },
      meta: numeric,
    }),
    columnHelper.display({
      id: "receipts",
      header: "Delivered · Read",
      cell: (info) => {
        const { delivered, read } = info.row.original.delivery;
        return (
          <span className="font-mono text-xs tabular-nums">
            {delivered} · {read}
          </span>
        );
      },
      meta: numeric,
    }),
    ...(showPhone
      ? [
          columnHelper.accessor("phoneNumberId", {
            id: "phone_number_id",
            header: "Phone",
            cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
            meta: { cellClassName: "text-foreground/80 break-all" },
          }),
        ]
      : []),
  ];
}

function BroadcastsPage() {
  const result = Route.useLoaderData();
  const { wabaId, cursor, trail } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const navigate = Route.useNavigate();
  const liveRefresh = useLiveRefresh("broadcasts");
  const refreshControls = <RefreshControls {...liveRefresh} />;
  const rows = useMemo(() => (result.ok ? result.data.items : []), [result]);

  if (!result.ok) {
    return (
      <Page title="Broadcasts" kicker="Sending" actions={refreshControls}>
        <FailureView failure={result} />
      </Page>
    );
  }

  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;
  const phones =
    ready?.scope.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];
  const nextCursor = result.data.nextCursor;

  return (
    <Page title="Broadcasts" kicker="Sending" actions={refreshControls}>
      <LogGrid
        key={cursor ?? "first"}
        columns={broadcastColumns(selectedWabaId, phones.length > 1)}
        data={rows}
        emptyMessage={
          <GridEmptyState
            label="NO BROADCASTS YET"
            description="Broadcasts you send with POST /v1/wabas/{wabaId}/broadcasts appear here."
            action={
              <a
                href="https://docs.eccos.chat/bulk-sending"
                target="_blank"
                rel="noreferrer"
                className="text-sm underline underline-offset-4"
              >
                Read the bulk sending guide
              </a>
            }
          />
        }
        getRowId={(row) => row.id}
        onRowClick={(row) =>
          navigate({
            to: "/broadcasts/$broadcastId",
            params: { broadcastId: row.id },
            search: selectedWabaId ? { wabaId: selectedWabaId } : {},
          })
        }
      />
      <LogPager param="cursor" cursor={cursor} trail={trail} nextCursor={nextCursor} />
    </Page>
  );
}
