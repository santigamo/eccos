import { useMemo, useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import { MetaErrorCell } from "../components/broadcasts/meta-error-cell";
import { FailureView } from "../components/dashboard/failure";
import { GridEmptyState } from "../components/grid/empty-state";
import { GridPending } from "../components/grid/grid-pending";
import { LogGrid } from "../components/grid/log-grid";
import { LogPager } from "../components/logs/log-pager";
import { normalizeSearchTrail, type PageTrail } from "../lib/page-trail";
import { RefreshControls } from "../components/logs/refresh-controls";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { CancelScheduledDialog } from "../components/scheduled/cancel-scheduled-dialog";
import { ScheduledStatusTabs } from "../components/scheduled/scheduled-status-tabs";
import { useLiveRefresh } from "../hooks/use-live-refresh";
import { loaderFailure } from "../lib/failure";
import { invalidatePage } from "../lib/invalidate";
import { EMPTY_CELL, wamidTail } from "../lib/logs";
import { LIVE_STALE_MS } from "../lib/route-stale";
import {
  normalizeScheduledStatus,
  normalizeScheduleKey,
  readsSoonestFirst,
  scheduledOutcome,
} from "../lib/scheduled";
import { normalizeSearchWabaId } from "../lib/search";
import { listScheduled } from "../server/gateway";
import type { ScheduledSend, ScheduledStatus } from "../server/gateway";
import { Page, fmtTs } from "../ui";

/**
 * ── SCHEDULED ───────────────────────────────────────────────────────────────
 * One approved template to one recipient at a set time, under the client's key.
 * One status at a time: pending reads soonest first, the ended ones newest first.
 * Outcomes speak the Eccos → Meta hop.
 */

type ScheduledSearch = { wabaId?: string; status?: ScheduledStatus; cursor?: string; trail?: PageTrail };

export const Route = createFileRoute("/scheduled")({
  staleTime: LIVE_STALE_MS,
  validateSearch: (search: Record<string, unknown>): ScheduledSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    status: normalizeScheduledStatus(search.status),
    cursor: normalizeScheduleKey(search.cursor),
    trail: normalizeSearchTrail(search.trail, search.cursor),
  }),
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId, status: search.status, cursor: search.cursor }),
  loader: ({ deps }) => listScheduled({ data: deps }).catch(loaderFailure),
  component: ScheduledPage,
  pendingComponent: () => <GridPending title="Scheduled" kicker="Sending" columns={scheduledColumns()} />,
});

const columnHelper = createColumnHelper<DataGridFeatures, ScheduledSend>();

function scheduledColumns(opts: { showPhone?: boolean; onCancel?: (row: ScheduledSend) => void } = {}) {
  return [
    columnHelper.accessor("sendAt", {
      id: "send_at",
      header: "Send at",
      cell: (info) => {
        const row = info.row.original;
        const open = row.status === "pending" || row.status === "sending";
        return (
          <>
            <span className="font-mono text-xs">{fmtTs(row.sendAt)}</span>
            {open ? (
              <span className="block text-xs text-muted-foreground">expires {fmtTs(row.expiresAt)}</span>
            ) : null}
          </>
        );
      },
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("key", {
      id: "key",
      header: "Key",
      cell: (info) => (
        <span
          className="font-mono text-xs break-all"
          title={`created ${fmtTs(info.row.original.createdAt)} · updated ${fmtTs(info.row.original.updatedAt)}`}
        >
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.accessor("to", {
      id: "to",
      header: "To",
      cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("template", {
      id: "template",
      header: "Template",
      cell: (info) => (
        <>
          {info.getValue().name}
          <span className="text-muted-foreground"> · {info.getValue().language}</span>
        </>
      ),
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("attempts", {
      id: "attempts",
      header: "Attempts",
      cell: (info) =>
        info.getValue() === 0 ? (
          <span className="text-muted-foreground">{EMPTY_CELL}</span>
        ) : (
          <span className="font-mono text-xs tabular-nums">{info.getValue()}</span>
        ),
      meta: { headerClassName: "text-right", cellClassName: "text-right whitespace-nowrap" },
    }),
    columnHelper.display({
      id: "outcome",
      header: "Outcome",
      cell: (info) => {
        const outcome = scheduledOutcome(info.row.original);
        if (!outcome) return <span className="text-muted-foreground">{EMPTY_CELL}</span>;
        switch (outcome.kind) {
          case "message":
            return (
              <span className="font-mono text-xs" title={outcome.messageId}>
                {wamidTail(outcome.messageId)}
              </span>
            );
          case "expired":
            return <span className="text-muted-foreground">expired</span>;
          case "error":
            return <MetaErrorCell raw={outcome.raw} />;
          case "unknown":
            return "unknown outcome";
        }
      },
      meta: { cellClassName: "text-foreground/80" },
    }),
    ...(opts.showPhone
      ? [
          columnHelper.accessor("phoneNumberId", {
            id: "phone_number_id",
            header: "Phone",
            cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
            meta: { cellClassName: "text-foreground/80 break-all" },
          }),
        ]
      : []),
    ...(opts.onCancel
      ? [
          columnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            cell: (info) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  opts.onCancel?.(info.row.original);
                }}
              >
                Cancel
              </Button>
            ),
            meta: { headerClassName: "text-right", cellClassName: "text-right whitespace-nowrap" },
          }),
        ]
      : []),
  ];
}

function ScheduledPage() {
  const result = Route.useLoaderData();
  const { wabaId, status = "pending", cursor, trail } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const router = useRouter();
  const navigate = Route.useNavigate();
  const liveRefresh = useLiveRefresh("scheduled");
  const refreshControls = <RefreshControls {...liveRefresh} />;
  const [cancelling, setCancelling] = useState<ScheduledSend | null>(null);
  const rows = useMemo(() => (result.ok ? result.data.items : []), [result]);

  if (!result.ok) {
    return (
      <Page title="Scheduled" kicker="Sending" actions={refreshControls}>
        <FailureView failure={result} />
      </Page>
    );
  }

  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;
  const phones =
    ready?.scope.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];
  const nextCursor = result.data.nextCursor;
  const goFirst = () => navigate({ search: (prev) => ({ ...prev, cursor: undefined }) });

  const emptyState =
    cursor !== undefined ? (
      <GridEmptyState
        label="NO MATCHES"
        description="No scheduled sends are left on this page."
        action={
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-sm" onClick={goFirst}>
            ← back to the first page
          </Button>
        }
      />
    ) : status === "pending" ? (
      <GridEmptyState
        label="NO SCHEDULED SENDS"
        description="Sends you schedule with PUT /v1/wabas/{wabaId}/scheduled/{key} appear here until they go out."
        action={
          <a
            href="https://docs.eccos.chat/scheduled-sends"
            target="_blank"
            rel="noreferrer"
            className="text-sm underline underline-offset-4"
          >
            Read the scheduled sends guide
          </a>
        }
      />
    ) : (
      <GridEmptyState
        label={`NO ${status.toUpperCase()} SENDS`}
        description={`None of this WABA's scheduled sends is ${status}.`}
        action={
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-sm"
            onClick={() => navigate({ search: () => (wabaId ? { wabaId } : {}) })}
          >
            Show pending
          </Button>
        }
      />
    );

  return (
    <Page title="Scheduled" kicker="Sending" actions={refreshControls}>
      <ScheduledStatusTabs counts={result.data.counts} status={status} wabaId={wabaId} />
      <LogGrid
        key={cursor ?? "first"}
        columns={scheduledColumns({
          showPhone: phones.length > 1,
          onCancel: status === "pending" ? setCancelling : undefined,
        })}
        data={rows}
        emptyMessage={emptyState}
        getRowId={(row) => row.key}
      />
      <LogPager
        param="cursor"
        cursor={cursor}
        trail={trail}
        nextCursor={nextCursor}
        firstLabel={readsSoonestFirst(status) ? "Soonest" : undefined}
      />
      {cancelling && selectedWabaId ? (
        <CancelScheduledDialog
          wabaId={selectedWabaId}
          scheduled={cancelling}
          onOpenChange={(open) => !open && setCancelling(null)}
          onCancelled={() => invalidatePage(router)}
        />
      ) : null}
    </Page>
  );
}
