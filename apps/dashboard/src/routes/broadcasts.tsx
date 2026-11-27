import { useMemo } from "react";
import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { BroadcastExample } from "../components/broadcasts/broadcast-example";
import { GridEmptyState } from "../components/grid/empty-state";
import { GridPending } from "../components/grid/grid-pending";
import { LogGrid } from "../components/grid/log-grid";
import { LogPager } from "../components/logs/log-pager";
import { normalizeSearchTrail, type PageTrail } from "../lib/page-trail";
import { RefreshControls } from "../components/logs/refresh-controls";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { FailureView } from "../components/dashboard/failure";
import { FirstRun } from "../components/sending/first-run";
import { useLiveRefresh } from "../hooks/use-live-refresh";
import { broadcastState, broadcastsFirstRun, normalizeBroadcastId } from "../lib/broadcasts";
import { broadcastCurl, wabaPath } from "../lib/curl";
import { loaderFailure } from "../lib/failure";
import { rootRole } from "../lib/root-role";
import { LIVE_STALE_MS } from "../lib/route-stale";
import { normalizeSearchWabaId } from "../lib/search";
import { rootSendsPaused } from "../lib/sends-paused";
import { gatewayOriginOrNull, listBroadcasts } from "../server/gateway";
import type { BroadcastSummary } from "../server/gateway";
import { COUNT_LINK, Page, StatusTag, fmtCount, fmtTs } from "../ui";

/**
 * ── BROADCASTS ──────────────────────────────────────────────────────────────
 * One approved template sent to many recipients, paced by the gateway. The
 * list is the campaigns; the recipients live one click down. Counts speak the
 * Eccos → Meta hop (`sent` / `failed`); Delivered and Read are Meta's later
 * receipts for the messages that were sent.
 */

type BroadcastsSearch = { wabaId?: string; cursor?: string; trail?: PageTrail };

const GUIDE = { href: "https://docs.eccos.chat/bulk-sending", label: "Bulk sending guide" };

export const Route = createFileRoute("/broadcasts")({
  staleTime: LIVE_STALE_MS,
  validateSearch: (search: Record<string, unknown>): BroadcastsSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    cursor: normalizeBroadcastId(search.cursor),
    trail: normalizeSearchTrail(search.trail, search.cursor),
  }),
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId, cursor: search.cursor }),
  loader: async ({ deps }) => {
    const list = await listBroadcasts({ data: deps }).catch(loaderFailure);
    // The origin only fills the first-run block's request.
    const firstRun = list.ok && broadcastsFirstRun(list.data.items, deps.cursor);
    const origin = firstRun ? await gatewayOriginOrNull() : null;
    return { list, origin };
  },
  component: BroadcastsPage,
  pendingComponent: () => (
    <GridPending title="Broadcasts" kicker="Sending" columns={broadcastColumns({ paused: false })} />
  ),
});

const columnHelper = createColumnHelper<DataGridFeatures, BroadcastSummary>();

const numeric = {
  headerClassName: "text-right",
  cellClassName: "text-right whitespace-nowrap",
};

const countCell = (value: number) => <span className="font-mono text-xs tabular-nums">{fmtCount(value)}</span>;

function broadcastColumns({ wabaId, showPhone = false, paused }: { wabaId?: string; showPhone?: boolean; paused: boolean }) {
  return [
    // The row's door: the same anatomy as the MESSAGE cell on /messages.
    columnHelper.accessor("template", {
      id: "broadcast",
      header: "Broadcast",
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
    columnHelper.accessor("createdAt", {
      id: "created",
      header: "Created",
      cell: (info) => <span className="font-mono text-xs">{fmtTs(info.getValue())}</span>,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("status", {
      id: "state",
      header: "State",
      cell: (info) => {
        const { label, reason } = broadcastState(info.row.original, paused);
        return (
          <span className="inline-flex items-center gap-2">
            <StatusTag status={label} />
            {reason ? <span className="max-w-64 truncate text-xs text-muted-foreground" title={reason}>{reason}</span> : null}
          </span>
        );
      },
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("total", {
      id: "recipients",
      header: "Recipients",
      cell: (info) => countCell(info.getValue()),
      meta: numeric,
    }),
    columnHelper.display({
      id: "sent",
      header: "Sent",
      cell: (info) => countCell(info.row.original.counts.sent),
      meta: numeric,
    }),
    columnHelper.display({
      id: "delivered",
      header: "Delivered",
      cell: (info) => countCell(info.row.original.delivery.delivered),
      meta: numeric,
    }),
    columnHelper.display({
      id: "read",
      header: "Read",
      cell: (info) => countCell(info.row.original.delivery.read),
      meta: numeric,
    }),
    columnHelper.display({
      id: "failed",
      header: "Failed",
      cell: (info) => {
        const { failed, unknown } = info.row.original.counts;
        if (failed + unknown === 0) return countCell(0);
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
                  {fmtCount(count)}
                  {status === "unknown" ? " unknown" : ""}
                </Link>
              ))}
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
  const { list: result, origin } = Route.useLoaderData();
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
  const backSearch = selectedWabaId ? { wabaId: selectedWabaId } : {};

  if (broadcastsFirstRun(rows, cursor)) {
    return (
      <Page title="Broadcasts" kicker="Sending" actions={refreshControls}>
        <FirstRun
          label="No broadcasts yet"
          title="Send one template to your whole list"
          lede="Bring a list of up to 10,000 people and Eccos sends each one their own message: an offer, an order that is ready, a change in opening hours."
          door={{
            sentence: "Your system sends the template and the list in one request.",
            requests: [{ method: "POST", path: wabaPath(selectedWabaId, "/broadcasts") }],
            curl: broadcastCurl(selectedWabaId, origin),
            guide: GUIDE,
            canCreateKey: rootRole(root)?.canAdminister ?? false,
          }}
          fullRequestLabel="The full request · one recipient shown"
          example={<BroadcastExample />}
          footnote="A broadcast starts as soon as Eccos accepts the request. You can cancel it here while it runs; messages already sent cannot be recalled."
        />
      </Page>
    );
  }

  return (
    <Page
      title="Broadcasts"
      kicker="Sending"
      actions={refreshControls}
      intro={
        <>
          One approved template to up to 10,000 people. Eccos paces the sends and reports every recipient here.{" "}
          <a href={GUIDE.href} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">
            {GUIDE.label} ↗
          </a>
        </>
      }
    >
      <LogGrid
        key={cursor ?? "first"}
        columns={broadcastColumns({ wabaId: selectedWabaId, showPhone: phones.length > 1, paused: rootSendsPaused(root) })}
        data={rows}
        emptyMessage={
          <GridEmptyState
            label="NO MORE BROADCASTS"
            description="There are no older broadcasts."
            action={
              <Link to="/broadcasts" search={backSearch} className="text-sm underline underline-offset-4">
                Back to the newest
              </Link>
            }
          />
        }
        getRowId={(row) => row.id}
        onRowClick={(row) =>
          navigate({
            to: "/broadcasts/$broadcastId",
            params: { broadcastId: row.id },
            search: backSearch,
          })
        }
      />
      <LogPager param="cursor" cursor={cursor} trail={trail} nextCursor={result.data.nextCursor} />
    </Page>
  );
}
