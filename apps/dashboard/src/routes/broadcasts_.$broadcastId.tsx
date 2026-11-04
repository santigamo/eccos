import { useMemo, useState } from "react";
import { createFileRoute, Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CancelBroadcastDialog } from "../components/broadcasts/cancel-broadcast-dialog";
import { RecipientCounts } from "../components/broadcasts/recipient-counts";
import { FailureView } from "../components/dashboard/failure";
import { GridEmptyState } from "../components/grid/empty-state";
import { GridPending } from "../components/grid/grid-pending";
import { LogGrid } from "../components/grid/log-grid";
import { LogPager } from "../components/logs/log-pager";
import { RefreshControls } from "../components/logs/refresh-controls";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { useLiveRefresh } from "../hooks/use-live-refresh";
import {
  RECIPIENT_STATUSES,
  broadcastStateLabel,
  normalizeBroadcastId,
  normalizeRecipientStatus,
  normalizeSeqCursor,
  recipientStateLabel,
} from "../lib/broadcasts";
import { loaderFailure } from "../lib/failure";
import { invalidatePage } from "../lib/invalidate";
import { EMPTY_CELL, errorReading, wamidTail } from "../lib/logs";
import { LIVE_STALE_MS } from "../lib/route-stale";
import { normalizeSearchWabaId } from "../lib/search";
import { getBroadcast } from "../server/gateway";
import type { BroadcastRecipientRow } from "../server/gateway";
import { FactCell, FactsStrip, Page, StatusTag, fmtTs } from "../ui";

/**
 * ── ONE BROADCAST ───────────────────────────────────────────────────────────
 * The campaign's summary, then its recipients in request order (seq), so a page
 * of them is the same page whenever it is loaded. Cancel is the one act.
 */

type BroadcastSearch = { wabaId?: string; status?: string; cursor?: string };

export const Route = createFileRoute("/broadcasts_/$broadcastId")({
  staleTime: LIVE_STALE_MS,
  validateSearch: (search: Record<string, unknown>): BroadcastSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    status: normalizeRecipientStatus(search.status),
    cursor: normalizeSeqCursor(search.cursor),
  }),
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId, status: search.status, cursor: search.cursor }),
  loader: ({ deps, params }) => {
    const broadcastId = normalizeBroadcastId(params.broadcastId);
    // A malformed id is just a broadcast that is not there.
    if (!broadcastId) return Promise.resolve({ ok: true as const, data: null });
    return getBroadcast({ data: { broadcastId, ...deps } }).catch(loaderFailure);
  },
  component: BroadcastPage,
  pendingComponent: () => (
    <GridPending title="Broadcast" kicker="Sending" columns={recipientColumns()} />
  ),
});

const columnHelper = createColumnHelper<DataGridFeatures, BroadcastRecipientRow>();

function recipientColumns() {
  return [
    columnHelper.accessor("seq", {
      id: "seq",
      header: "#",
      cell: (info) => <span className="font-mono text-xs tabular-nums">{info.getValue() + 1}</span>,
      meta: { headerClassName: "text-right", cellClassName: "text-right whitespace-nowrap" },
    }),
    columnHelper.accessor("to", {
      id: "to",
      header: "To",
      cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("status", {
      id: "state",
      header: "State",
      cell: (info) => <StatusTag status={recipientStateLabel(info.row.original)} />,
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
    columnHelper.accessor("messageId", {
      id: "message",
      header: "Message",
      cell: (info) => {
        const id = info.getValue();
        return id ? (
          <span className="font-mono text-xs" title={id}>
            {wamidTail(id)}
          </span>
        ) : (
          <span className="text-muted-foreground">{EMPTY_CELL}</span>
        );
      },
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("error", {
      id: "error",
      header: "Error",
      cell: (info) => {
        const raw = info.getValue();
        if (!raw) return EMPTY_CELL;
        const { code, text, label } = errorReading(raw);
        return (
          <span className="line-clamp-2 max-w-sm [overflow-wrap:anywhere]" title={label}>
            {code ? <span className="font-mono text-xs">{code} · </span> : null}
            {text}
          </span>
        );
      },
      meta: { cellClassName: "text-foreground/80" },
    }),
  ];
}

function BroadcastPage() {
  const result = Route.useLoaderData();
  const { wabaId, status, cursor } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const navigate = Route.useNavigate();
  const router = useRouter();
  const liveRefresh = useLiveRefresh("broadcast");
  const [cancelOpen, setCancelOpen] = useState(false);
  const rows = useMemo(() => (result.ok && result.data ? result.data.recipients.items : []), [result]);

  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;
  const backSearch = selectedWabaId ? { wabaId: selectedWabaId } : {};
  const refreshControls = <RefreshControls {...liveRefresh} />;

  if (!result.ok) {
    return (
      <Page title="Broadcast" kicker="Sending" actions={refreshControls}>
        <FailureView failure={result} />
      </Page>
    );
  }

  if (result.data === null) {
    return (
      <Page title="Broadcast" kicker="Sending">
        <GridEmptyState
          label="BROADCAST NOT FOUND"
          description="It may belong to another workspace, or have been removed by the content retention window."
          action={
            <Link to="/broadcasts" search={backSearch} className="text-sm underline underline-offset-4">
              Back to broadcasts
            </Link>
          }
        />
      </Page>
    );
  }

  const { broadcast, recipients } = result.data;
  const { counts, delivery } = broadcast;
  const running = broadcast.status === "running";
  const nextCursor = recipients.nextCursor;

  const filter = (
    <>
      <label className="sr-only" htmlFor="recipient-status-filter">
        Filter recipients by state
      </label>
      <Select
        value={status ?? "all"}
        onValueChange={(value) =>
          navigate({
            search: (prev) => ({
              ...prev,
              status: !value || value === "all" ? undefined : value,
              cursor: undefined,
            }),
          })
        }
      >
        <SelectTrigger id="recipient-status-filter" size="sm" className="w-36">
          <SelectValue>{(value: string | null) => (value === "all" ? "all recipients" : value)}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="all">all recipients</SelectItem>
          {RECIPIENT_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );

  const emptyState =
    status !== undefined || cursor !== undefined ? (
      <GridEmptyState
        label="NO MATCHES"
        description="No recipients match this view."
        action={
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-sm"
            onClick={() => navigate({ search: () => (wabaId ? { wabaId } : {}) })}
          >
            Clear filter
          </Button>
        }
      />
    ) : (
      <GridEmptyState label="NO RECIPIENTS" description="This broadcast holds no recipients." />
    );

  return (
    <Page
      title={`${broadcast.template.name} · ${broadcast.template.language}`}
      kicker="Sending"
      actions={
        <>
          <Link
            to="/broadcasts"
            search={backSearch}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            ← Broadcasts
          </Link>
          {refreshControls}
          {running ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setCancelOpen(true)}>
              Cancel broadcast
            </Button>
          ) : null}
        </>
      }
    >
      <div className="mb-3 flex items-center gap-3">
        <StatusTag status={broadcastStateLabel(broadcast)} />
      </div>
      {broadcast.status === "halted" ? (
        <output className="mb-4 block border-l-2 border-destructive px-3 py-2 text-sm text-destructive-foreground">
          Stopped: {broadcast.haltReason ?? "the gateway stopped this broadcast"}
        </output>
      ) : null}

      <FactsStrip label="Broadcast totals">
        <FactCell
          kicker="Recipients"
          value={broadcast.total}
          caption={
            broadcast.duplicatesSkipped > 0
              ? `${broadcast.duplicatesSkipped} duplicates skipped`
              : "no duplicates"
          }
        >
          <RecipientCounts
            broadcastId={broadcast.id}
            counts={counts}
            wabaId={selectedWabaId}
          />
        </FactCell>
        <FactCell kicker="Sent" value={counts.sent} caption="Eccos → Meta accepted" />
        <FactCell
          kicker="Delivered"
          value={delivery.delivered}
          caption={`${delivery.read} read · ${delivery.failed} failed after sending`}
        />
      </FactsStrip>
      <p className="mt-3 text-sm text-muted-foreground">
        Created <span className="font-mono text-xs">{fmtTs(broadcast.createdAt)}</span> ·{" "}
        {broadcast.ratePerMinute}/min · finished{" "}
        <span className="font-mono text-xs">
          {broadcast.finishedAt === null ? EMPTY_CELL : fmtTs(broadcast.finishedAt)}
        </span>{" "}
        · phone <span className="font-mono text-xs">{broadcast.phoneNumberId}</span> · id{" "}
        <span className="font-mono text-xs select-all">{broadcast.id}</span>
      </p>

      <div className="mt-6 flex items-center justify-between gap-3 pb-3">
        <h2 className="text-[11px] font-medium tracking-wider uppercase text-muted-foreground">Recipients</h2>
        {filter}
      </div>
      <LogGrid
        columns={recipientColumns()}
        data={rows}
        emptyMessage={emptyState}
        getRowId={(row) => String(row.seq)}
      />
      <LogPager
        canLoadOlder={nextCursor !== null}
        hasCursor={cursor !== undefined}
        labels={{ first: "← First", next: "Next →" }}
        onLatest={() => navigate({ search: (prev) => ({ ...prev, cursor: undefined }) })}
        onOlder={() => nextCursor !== null && navigate({ search: (prev) => ({ ...prev, cursor: nextCursor }) })}
      />

      {cancelOpen && selectedWabaId ? (
        <CancelBroadcastDialog
          wabaId={selectedWabaId}
          broadcast={broadcast}
          onOpenChange={setCancelOpen}
          onCancelled={() => invalidatePage(router)}
        />
      ) : null}
    </Page>
  );
}
